import { buildUniqueFileId, endUpload } from '../upload/uploadTools.js';
import { getDatabase } from '../utils/databaseAdapter.js';
import { TelegramAPI } from '../utils/storage/telegramAPI.js';

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
export async function handleTelegramMessage(context, update, config) {
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

    // 使用传入的 config（由 telegram.js 已读取并解析）
    if (!config.enabled || !config.targetChannel) {
        return { success: false, reason: 'webhook_disabled' };
    }

    // 提前获取渠道配置和 TelegramAPI（去重回复和后续上传都需要）
    const channel = await getTelegramChannel(db, config.targetChannel);
    if (!channel) {
        return { success: false, reason: 'channel_not_found' };
    }
    const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');

    // 检查图片是否已经保存过（反向索引去重，O(1) 读取）
    const existingFileId = await db.findByTgFileId(fileId);
    if (existingFileId) {
        console.log(`File already saved: ${existingFileId}, skipping duplicate`);
        return { success: false, reason: 'already_saved', existingFileId };
    }

    // 获取用户设置的上传目录
    const uploadDir = await db.get(`telegram_upload_dir_${chatId}`) || '';

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

        // 写入去重索引（KV 写反向索引，D1 无需额外操作）
        await db.saveTgDedup(fileId, fullId);

        // 如果是批量上传，记录用于统计（KV 写 batch_index，D1 无需额外操作）
        if (mediaGroupId) {
            await db.saveBatchFile(mediaGroupId, fullId, metadata.FileSize);
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

    // 处理回复逻辑（telegramAPI 已在上方初始化）
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

        // 每个 handler 写入自己的时间戳，用于去抖
        batchInfo.lastUpdated = Date.now();
        const myTimestamp = batchInfo.lastUpdated;

        await db.put(batchKey, JSON.stringify(batchInfo), {
            expirationTtl: 120
        });

        context.waitUntil((async () => {
            try {
                // Phase 1: 初始等待
                await new Promise(resolve => setTimeout(resolve, 5000));

                let data = await db.get(batchKey);
                if (!data) return;
                let info = JSON.parse(data);
                // 不是最后一个 handler → 立即退出，不做任何 DB 操作
                if (info.lastUpdated !== myTimestamp) return;

                // Phase 2: 二次确认，等待可能的大图/慢图到达
                await new Promise(resolve => setTimeout(resolve, 5000));

                data = await db.get(batchKey);
                if (!data) return;
                info = JSON.parse(data);
                // 新的 handler 出现了 → 让它来处理
                if (info.lastUpdated !== myTimestamp) return;

                // 确认是最后一个 handler，统计并发送最终消息
                const batchStats = await db.countBatchFiles(mediaGroupId);

                if (info.messageId) {
                    await telegramAPI.editMessageText(
                        chatId,
                        info.messageId,
                        `✅ 批量保存完成\n` +
                        `共保存: ${batchStats.count} 张图片\n` +
                        `总大小: ${batchStats.totalSize.toFixed(2)}MB\n` +
                        `首个文件ID: ${info.firstFileId}`
                    );
                }

                // 清理 batchKey
                try { await db.delete(batchKey); } catch (e) { /* ignore */ }
            } catch (error) {
                console.error('Batch waitUntil error:', error);
                // 出错也要尝试清理，避免残留记录影响后续
                try { await db.delete(batchKey); } catch (e) { /* ignore */ }
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
