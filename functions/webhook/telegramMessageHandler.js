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
        Tags: []
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

    // 发送成功回复消息
    try {
        const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
        await telegramAPI.sendMessage(chatId, `✅ 图片已保存\n文件ID: ${fullId}\n大小: ${metadata.FileSize}MB`);
    } catch (error) {
        console.error('Failed to send reply:', error);
    }

    return {
        success: true,
        fileId: fullId,
        metadata
    };
}
