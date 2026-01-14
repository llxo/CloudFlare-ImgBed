import { buildUniqueFileId, endUpload } from '../upload/uploadTools.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { TelegramAPI } from '../utils/telegramAPI.js';

/**
 * 获取 Telegram 渠道配置
 */
async function getTelegramChannel(db, channelName) {
    const uploadConfigStr = await db.get('manage@sysConfig@upload');
    if (!uploadConfigStr) {
        return null;
    }

    const uploadConfig = JSON.parse(uploadConfigStr);
    const channels = uploadConfig.telegram?.channels || [];

    return channels.find(ch => ch.name === channelName);
}

/**
 * 处理 Telegram Webhook 消息
 * @param {Object} context - 上下文对象
 * @param {Object} update - Telegram Update 对象
 * @returns {Promise<Object>} 处理结果
 */
export async function handleTelegramMessage(context, update) {
    const { env } = context;

    const message = update.message;
    if (!message) {
        return { success: false, reason: 'no_message' };
    }

    const chatId = message.chat.id.toString();
    const db = getDatabase(env);
    
    // 处理命令
    if (message.text && message.text.startsWith('/')) {
        const parts = message.text.trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        
        if (command === '/dir') {
            const webhookConfig = await db.get('manage@sysConfig@telegram@webhook');
            if (!webhookConfig) {
                return { success: false, reason: 'webhook_not_configured' };
            }
            const config = JSON.parse(webhookConfig);
            const channel = await getTelegramChannel(db, config.targetChannel);
            if (!channel) {
                return { success: false, reason: 'channel_not_found' };
            }
            
            const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
            
            if (parts.length < 2) {
                // 查询当前目录
                const currentDir = await db.get(`telegram_upload_dir_${chatId}`) || '/';
                await telegramAPI.sendMessage(chatId, `📁 当前上传目录: ${currentDir}\n\n使用方法: /dir 目录名`);
            } else {
                // 设置目录
                const dirName = parts.slice(1).join(' ').trim();
                await db.put(`telegram_upload_dir_${chatId}`, dirName);
                await telegramAPI.sendMessage(chatId, `✅ 上传目录已设置为: ${dirName}`);
            }
            return { success: true, reason: 'command_handled' };
        }
    }

    let fileId, fileSize, fileName, fileType;
    
    // 添加日志，查看 media_group_id
    console.log('Message media_group_id:', message.media_group_id);
    console.log('Message type:', message.photo ? 'photo' : (message.document ? 'document' : 'other'));

    // 处理照片消息（压缩图片）
    if (message.photo) {
        const largestPhoto = message.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        );
        fileId = largestPhoto.file_id;
        fileSize = largestPhoto.file_size;
        const timestamp = new Date().toISOString().split('T')[0];
        fileName = `photo_${timestamp}_${Date.now()}.jpg`;
        fileType = "image/jpeg";
    }
    // 处理文件消息（原图）
    else if (message.document && message.document.mime_type?.startsWith('image/')) {
        fileId = message.document.file_id;
        fileSize = message.document.file_size;
        fileName = message.document.file_name || `document_${Date.now()}.jpg`;
        fileType = message.document.mime_type || "image/jpeg";
    }
    else {
        return { success: false, reason: 'not_image' };
    }

    // 获取系统配置
    const webhookConfig = await db.get('manage@sysConfig@telegram@webhook');

    if (!webhookConfig) {
        return { success: false, reason: 'webhook_not_configured' };
    }

    const config = JSON.parse(webhookConfig);
    if (!config.enabled || !config.targetChannel) {
        return { success: false, reason: 'webhook_disabled' };
    }

    // 检查图片是否已经保存过（去重）
    const existingFiles = await db.list({ prefix: '' });
    for (const key of existingFiles.keys) {
        const fileData = await db.getWithMetadata(key.name);
        if (fileData.metadata?.TgFileId === fileId) {
            console.log(`File already saved: ${key.name}, skipping duplicate`);
            return { success: false, reason: 'already_saved', existingFileId: key.name };
        }
    }

    // 获取用户设置的上传目录
    const uploadDir = await db.get(`telegram_upload_dir_${chatId}`) || '';

    // 获取目标渠道配置
    const channel = await getTelegramChannel(db, config.targetChannel);
    if (!channel) {
        return { success: false, reason: 'channel_not_found' };
    }

    // 构建 context 用于生成唯一文件 ID
    const requestUrl = new URL(context.request.url);
    const uploadContext = {
        env,
        url: new URL(`${requestUrl.origin}?uploadNameType=index&uploadFolder=${encodeURIComponent(uploadDir)}`)
    };

    // 生成唯一文件 ID
    const fullId = await buildUniqueFileId(uploadContext, fileName, 'image/jpeg');
    
    // 从 fullId 中提取实际的目录（与索引管理器保持一致）
    const lastSlashIndex = fullId.lastIndexOf('/');
    const actualDirectory = lastSlashIndex === -1 ? '' : fullId.substring(0, lastSlashIndex + 1);

    // 构建 metadata
    const metadata = {
        Channel: "TelegramNew",
        ChannelName: channel.name || config.targetChannel,
        TgFileId: fileId,
        TgChatId: chatId,
        TgBotToken: channel.botToken,
        FileName: fileName,
        FileType: "image/jpeg",
        FileSize: (fileSize / 1024 / 1024).toFixed(2),
        UploadIP: "Bot",
        TimeStamp: Date.now(),
        Label: "None",
        Directory: actualDirectory,
        Tags: [],
        MediaGroupId: message.media_group_id || null
    };

    // 如果配置了代理域名，保存到 metadata
    if (channel.proxyUrl) {
        metadata.TgProxyUrl = channel.proxyUrl;
    }

    // 获取 mediaGroupId
    const mediaGroupId = message.media_group_id;

    // 写入数据库
    try {
        await db.put(fullId, "", { metadata });
        
        // 如果是批量上传，创建索引便于统计
        if (mediaGroupId) {
            const batchIndexKey = `batch_index_${mediaGroupId}_${fullId}`;
            await db.put(batchIndexKey, fullId, { 
                expirationTtl: 3600,
                metadata: { size: metadata.FileSize }
            });
        }
    } catch (error) {
        console.error('Failed to write to database:', error);
        return { success: false, reason: 'database_error', error: error.message };
    }

    // 结束上传（更新索引）
    try {
        await endUpload(uploadContext, fullId, metadata);
    } catch (error) {
        console.error('Failed to update index:', error);
    }

    // 处理批量图片的回复逻辑
    const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
    
    if (mediaGroupId) {
        const batchKey = `telegram_batch_${mediaGroupId}`;
        const batchData = await db.get(batchKey);
        
        let batchInfo = batchData ? JSON.parse(batchData) : { 
            messageId: null,
            firstFileId: null
        };
        
        if (!batchInfo.firstFileId) {
            batchInfo.firstFileId = fullId;
        }
        
        // 只在第一张图片时发送消息
        if (!batchInfo.messageId) {
            try {
                const response = await telegramAPI.sendMessage(
                    chatId,
                    `📥 正在接收批量图片...`
                );
                if (response.ok) {
                    batchInfo.messageId = response.result.message_id;
                }
            } catch (error) {
                console.error('Failed to send batch message:', error);
            }
        }
        
        await db.put(batchKey, JSON.stringify(batchInfo), { 
            expirationTtl: 60 
        });
        
        context.waitUntil((async () => {
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const finalBatchData = await db.get(batchKey);
            if (!finalBatchData) return;
            
            const finalBatchInfo = JSON.parse(finalBatchData);
            
            // 查询最终准确数量
            const finalBatchFiles = await db.list({ prefix: `batch_index_${mediaGroupId}_` });
            const finalCount = finalBatchFiles.keys.length;
            let finalTotalSize = 0;
            for (const key of finalBatchFiles.keys) {
                const fileData = await db.getWithMetadata(key.name);
                finalTotalSize += parseFloat(fileData.metadata?.size || 0);
            }
            
            try {
                await telegramAPI.editMessageText(
                    chatId,
                    finalBatchInfo.messageId,
                    `✅ 批量保存完成\n` +
                    `共保存: ${finalCount} 张图片\n` +
                    `总大小: ${finalTotalSize.toFixed(2)}MB\n` +
                    `首个文件ID: ${finalBatchInfo.firstFileId}`
                );
                await db.delete(batchKey);
            } catch (error) {
                console.error('Failed to finalize batch message:', error);
            }
        })());
    } else {
        try {
            await telegramAPI.sendMessage(chatId, `✅ 图片已保存\n文件ID: ${fullId}\n大小: ${metadata.FileSize}MB`);
        } catch (error) {
            console.error('Failed to send reply:', error);
        }
    }

    return {
        success: true,
        fileId: fullId,
        metadata,
        mediaGroupId
    };
}
