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

    let fileId, fileSize, fileName, fileType;
    const chatId = message.chat.id.toString();
    
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
    const db = getDatabase(env);
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


    // 获取目标渠道配置
    const channel = await getTelegramChannel(db, config.targetChannel);
    if (!channel) {
        return { success: false, reason: 'channel_not_found' };
    }

    // 构建 context 用于生成唯一文件 ID
    const uploadContext = {
        env,
        url: new URL(`https://dummy.com?uploadNameType=index&uploadFolder=`)
    };

    // 生成唯一文件 ID
    const fullId = await buildUniqueFileId(uploadContext, fileName, 'image/jpeg');

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
        Directory: "",
        Tags: [],
        MediaGroupId: message.media_group_id || null
    };

    // 如果配置了代理域名，保存到 metadata
    if (channel.proxyUrl) {
        metadata.TgProxyUrl = channel.proxyUrl;
    }

    // 写入数据库
    try {
        await db.put(fullId, "", { metadata });
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
    const mediaGroupId = message.media_group_id;
    const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
    
    if (mediaGroupId) {
        // 批量上传模式：接收时用计数器，结束时查数据库
        const batchKey = `telegram_batch_${mediaGroupId}`;
        const batchData = await db.get(batchKey);
        
        let batchInfo = batchData ? JSON.parse(batchData) : { 
            count: 0,
            totalSize: 0,
            messageId: null,
            firstFileId: null,
            lastEditTime: 0
        };
        
        // 快速计数，不查询数据库
        batchInfo.count++;
        batchInfo.totalSize += parseFloat(metadata.FileSize);
        
        if (!batchInfo.firstFileId) {
            batchInfo.firstFileId = fullId;
        }
        
        // 节流：只在距离上次编辑超过500ms时才更新消息
        const now = Date.now();
        const shouldEdit = (now - batchInfo.lastEditTime) >= 500;
        
        try {
            if (batchInfo.messageId && shouldEdit) {
                // 编辑已有消息（节流）
                try {
                    await telegramAPI.editMessageText(
                        chatId,
                        batchInfo.messageId,
                        `📥 正在接收图片...\n` +
                        `已保存: ${batchInfo.count} 张\n` +
                        `总大小: ${batchInfo.totalSize.toFixed(2)}MB`
                    );
                    batchInfo.lastEditTime = now;
                } catch (error) {
                    // 忽略 "message is not modified" 错误
                    if (!error.message?.includes('message is not modified')) {
                        console.error('Failed to edit batch message:', error);
                    }
                }
            } else if (!batchInfo.messageId) {
                // 发送新消息
                const response = await telegramAPI.sendMessage(
                    chatId,
                    `📥 正在接收图片...\n` +
                    `已保存: ${batchInfo.count} 张\n` +
                    `总大小: ${batchInfo.totalSize.toFixed(2)}MB`
                );
                if (response.ok) {
                    batchInfo.messageId = response.result.message_id;
                    batchInfo.lastEditTime = now;
                }
            }
        } catch (error) {
            console.error('Failed to update batch message:', error);
        }
        
        // 保存批次信息，设置 60 秒过期时间
        await db.put(batchKey, JSON.stringify(batchInfo), { 
            expirationTtl: 60 
        });
        
        // 异步检查批次是否结束（不阻塞当前请求）
        context.waitUntil((async () => {
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            const finalBatchData = await db.get(batchKey);
            if (!finalBatchData) return;
            
            const finalBatchInfo = JSON.parse(finalBatchData);
            
            // 直接使用计数器数据（已经很准确了）
            try {
                await telegramAPI.editMessageText(
                    chatId,
                    finalBatchInfo.messageId,
                    `✅ 批量保存完成\n` +
                    `共保存: ${finalBatchInfo.count} 张图片\n` +
                    `总大小: ${finalBatchInfo.totalSize.toFixed(2)}MB\n` +
                    `首个文件ID: ${finalBatchInfo.firstFileId}`
                );
                await db.delete(batchKey);
            } catch (error) {
                console.error('Failed to finalize batch message:', error);
            }
        })());
    } else {
        // 单张图片：直接回复
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
