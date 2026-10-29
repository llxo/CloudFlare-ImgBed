import { getDatabase } from '../utils/databaseAdapter.js';
import { TelegramAPI } from '../utils/storage/telegramAPI.js';
import { addFileToIndex, removeFileFromIndex } from '../utils/indexManager.js';

/**
 * 快速解析二进制头部图片的真实尺寸（专用于 Document 原图，零外部依赖）
 */
function parseImageDimensions(buffer) {
    if (!buffer || buffer.byteLength < 8) return null;
    try {
        const view = new DataView(buffer);
        const uint8 = new Uint8Array(buffer);

        // PNG (89 50 4E 47)
        if (uint8[0] === 0x89 && uint8[1] === 0x50 && uint8[2] === 0x4E && uint8[3] === 0x47) {
            if (buffer.byteLength >= 24) {
                return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
            }
        }

        // JPEG (FF D8 FF)
        if (uint8[0] === 0xFF && uint8[1] === 0xD8 && uint8[2] === 0xFF) {
            let offset = 2;
            while (offset < buffer.byteLength - 9) {
                if (uint8[offset] !== 0xFF) break;
                const marker = uint8[offset + 1];
                if (marker >= 0xC0 && marker <= 0xC3 && marker !== 0xC4) {
                    return {
                        height: view.getUint16(offset + 5, false),
                        width: view.getUint16(offset + 7, false)
                    };
                }
                offset += 2 + view.getUint16(offset + 2, false);
            }
            return null;
        }

        // GIF (GIF87a / GIF89a)
        if (uint8[0] === 0x47 && uint8[1] === 0x49 && uint8[2] === 0x46) {
            if (buffer.byteLength >= 10) {
                return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
            }
        }

        // WebP (RIFF....WEBP)
        if (uint8[0] === 0x52 && uint8[1] === 0x49 && uint8[2] === 0x46 && uint8[3] === 0x46 &&
            uint8[8] === 0x57 && uint8[9] === 0x45 && uint8[10] === 0x42 && uint8[11] === 0x50) {
            if (uint8[12] === 0x56 && uint8[13] === 0x50 && uint8[14] === 0x38 && uint8[15] === 0x20) {
                if (buffer.byteLength >= 30) {
                    return { width: view.getUint16(26, true) & 0x3FFF, height: view.getUint16(28, true) & 0x3FFF };
                }
            }
            if (uint8[12] === 0x56 && uint8[13] === 0x50 && uint8[14] === 0x38 && uint8[15] === 0x4C) {
                if (buffer.byteLength >= 25) {
                    const bits = view.getUint32(21, true);
                    return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1 };
                }
            }
            if (uint8[12] === 0x56 && uint8[13] === 0x50 && uint8[14] === 0x38 && uint8[15] === 0x58) {
                if (buffer.byteLength >= 30) {
                    return {
                        width: (uint8[24] | (uint8[25] << 8) | (uint8[26] << 16)) + 1,
                        height: (uint8[27] | (uint8[28] << 8) | (uint8[29] << 16)) + 1
                    };
                }
            }
            return null;
        }

        // BMP (BM)
        if (uint8[0] === 0x42 && uint8[1] === 0x4D && buffer.byteLength >= 26) {
            return { width: view.getInt32(18, true), height: Math.abs(view.getInt32(22, true)) };
        }

        return null;
    } catch (_) {
        return null;
    }
}

// ==================== 1. 内存级全局单例缓存（0ms 直取） ====================
let cachedChannel = null;
let cachedChannelTime = 0;
const CHANNEL_CACHE_TTL_MS = 5 * 60 * 1000;

// 会话上传目录内存缓存
const chatDirCache = new Map();

/**
 * 极速获取 Telegram 渠道配置（绝大多数请求 0ms 直接命中内存）
 */
async function getFastTelegramChannel(db, channelName) {
    const now = Date.now();
    if (cachedChannel && cachedChannel.name === channelName && (now - cachedChannelTime < CHANNEL_CACHE_TTL_MS)) {
        return cachedChannel;
    }

    const uploadConfigStr = await db.get('manage@sysConfig@upload');
    if (!uploadConfigStr) return null;

    try {
        const uploadConfig = JSON.parse(uploadConfigStr);
        const channels = uploadConfig.telegram?.channels || [];
        const channel = channels.find(ch => ch.name === channelName) || channels[0];
        if (channel) {
            cachedChannel = channel;
            cachedChannelTime = now;
        }
        return channel;
    } catch (_) {
        return null;
    }
}

/**
 * 获取会话上传目录（优先内存直取）
 */
async function getFastChatDir(db, chatId) {
    if (chatDirCache.has(chatId)) {
        return chatDirCache.get(chatId);
    }
    const raw = await db.get(`telegram_upload_dir_${chatId}`);
    const normalized = (raw && raw !== '/' && raw.toLowerCase() !== 'root')
        ? raw.replace(/^\/+|\/+$/g, '')
        : '';
    chatDirCache.set(chatId, normalized);
    return normalized;
}

/**
 * 根据 MIME 或文件名快速推导扩展名（0ms 纯计算）
 */
function getQuickExtension(fileName, fileType) {
    if (fileName && fileName.includes('.')) {
        const ext = fileName.split('.').pop().toLowerCase();
        if (ext && ext.length <= 5) return ext;
    }
    const mimeMap = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'image/svg+xml': 'svg',
        'image/bmp': 'bmp'
    };
    return mimeMap[fileType] || 'jpg';
}

/**
 * 极致轻量化的 Telegram Webhook 消息处理器
 */
export async function handleTelegramMessage(context, update, config) {
    const { env } = context;
    const message = update.message;
    if (!message) {
        return { success: false, reason: 'no_message' };
    }

    const chatId = message.chat.id.toString();
    const db = getDatabase(env);

    // ==================== 2. 引用回复快捷删除 ====================
    if (message.reply_to_message && message.text && ['删', '删除', 'del'].includes(message.text.trim().toLowerCase())) {
        const channel = await getFastTelegramChannel(db, config.targetChannel);
        if (!channel) return { success: false, reason: 'channel_not_found' };
        const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');

        const replied = message.reply_to_message;
        const tgFile = replied.photo ? replied.photo[replied.photo.length - 1] : replied.document;
        const tgFileId = tgFile?.file_id;
        const tgFileUniqueId = tgFile?.file_unique_id;
        const fileName = replied.document?.file_name;

        let targetId = null;
        let displayName = fileName || '';

        if (env.img_d1) {
            // D1: 直查 files 表
            const row = await env.img_d1.prepare(
                'SELECT id, file_name FROM files WHERE tg_file_id = ? OR file_name = ? ORDER BY timestamp DESC LIMIT 1'
            ).bind(tgFileId || '', fileName || '').first();
            if (row?.id) {
                targetId = row.id;
                if (row.file_name) displayName = row.file_name;
            }
        } else {
            // KV: 点查反向映射
            targetId = await db.findByTgFile(tgFileUniqueId, tgFileId);
        }

        if (targetId) {
            await db.delete(targetId);
            await removeFileFromIndex(context, targetId);
            const nameDisplay = displayName ? ` (${displayName})` : '';
            await telegramAPI.sendMessage(chatId, `🗑️ 已删除: <code>${targetId}</code>${nameDisplay}`, { parse_mode: 'HTML' });
            return { success: true, reason: 'file_deleted', fileId: targetId };
        } else {
            await telegramAPI.sendMessage(chatId, '⚠️ 未找到对应图片');
            return { success: false, reason: 'not_found' };
        }
    }

    // ==================== 3. 指令交互 (/dir, /help, /start) ====================
    if (message.text && message.text.startsWith('/')) {
        const parts = message.text.trim().split(/\s+/);
        const command = parts[0].toLowerCase();

        const channel = await getFastTelegramChannel(db, config.targetChannel);
        if (!channel) return { success: false, reason: 'channel_not_found' };
        const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');

        if (command === '/dir') {
            if (parts.length < 2) {
                const currentDir = await getFastChatDir(db, chatId);
                await telegramAPI.sendMessage(
                    chatId,
                    `📁 <b>当前上传目录</b>: <code>${currentDir ? '/' + currentDir + '/' : '/'}</code>\n\n` +
                    `修改目录: <code>/dir 目录名</code>\n` +
                    `重置根目录: <code>/dir /</code>`,
                    { parse_mode: 'HTML' }
                );
            } else {
                let dirName = parts.slice(1).join(' ').trim();
                dirName = (dirName === '/' || dirName.toLowerCase() === 'root')
                    ? ''
                    : dirName.replace(/^\/+|\/+$/g, '');

                chatDirCache.set(chatId, dirName);
                if (dirName) {
                    await db.put(`telegram_upload_dir_${chatId}`, dirName);
                    await telegramAPI.sendMessage(chatId, `✅ 上传目录已设置为: <code>/${dirName}/</code>`, { parse_mode: 'HTML' });
                } else {
                    await db.delete(`telegram_upload_dir_${chatId}`);
                    await telegramAPI.sendMessage(chatId, `✅ 上传目录已重置为根目录 <code>/</code>`, { parse_mode: 'HTML' });
                }
            }
            return { success: true, reason: 'command_handled' };
        } else if (command === '/help' || command === '/start') {
            const currentDir = await getFastChatDir(db, chatId);
            await telegramAPI.sendMessage(
                chatId,
                `🤖 <b>Cloudflare-ImgBed 图床机器人已就绪</b>\n\n` +
                `📌 <b>使用说明</b>：\n` +
                `• 直接发送图片或原图文档，将自动秒级保存。\n` +
                `• 相同图片基于永久全局唯一指纹自动去重。\n` +
                `• 引用回复任意图片发送“删”，即可快速从图库移除。\n\n` +
                `📁 <b>当前存储目录</b>: <code>${currentDir ? '/' + currentDir + '/' : '/'}</code>\n` +
                `• 切换目录: <code>/dir 目录名</code>\n` +
                `• 重置目录: <code>/dir /</code>`,
                { parse_mode: 'HTML' }
            );
            return { success: true, reason: 'command_handled' };
        }
    }

    // ==================== 3. 媒体解析 (Photo / Document) ====================
    let fileId, fileUniqueId, fileSize, fileName, fileType;
    let width = null, height = null;

    if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
        const largestPhoto = message.photo[message.photo.length - 1];
        fileId = largestPhoto.file_id;
        fileUniqueId = largestPhoto.file_unique_id;
        fileSize = largestPhoto.file_size || 0;
        fileType = 'image/jpeg';
        fileName = `photo_${Date.now()}.${getQuickExtension(null, fileType)}`;
        if (largestPhoto.width && largestPhoto.height) {
            width = largestPhoto.width;
            height = largestPhoto.height;
        }
    } else if (message.document && message.document.mime_type?.startsWith('image/')) {
        fileId = message.document.file_id;
        fileUniqueId = message.document.file_unique_id;
        fileSize = message.document.file_size || 0;
        fileType = message.document.mime_type;
        fileName = message.document.file_name || `document_${Date.now()}.${getQuickExtension(null, fileType)}`;
        // Document thumbnail 作为备用尺寸
        if (message.document.thumbnail?.width && message.document.thumbnail?.height) {
            width = message.document.thumbnail.width;
            height = message.document.thumbnail.height;
        }
    } else {
        return { success: false, reason: 'not_image' };
    }

    const mediaGroupId = message.media_group_id || null;

    // ==================== 4. 并行加速：配置获取 + 去重检查 + 目录读取 ====================
    const [channel, existingFileId, uploadDir] = await Promise.all([
        getFastTelegramChannel(db, config.targetChannel),
        db.findByTgFile(fileUniqueId, fileId),
        getFastChatDir(db, chatId)
    ]);

    if (!channel) {
        return { success: false, reason: 'channel_not_found' };
    }

    const telegramAPI = new TelegramAPI(channel.botToken, channel.proxyUrl || '');

    // 命中秒级去重
    if (existingFileId) {
        if (!mediaGroupId) {
            await telegramAPI.sendMessage(
                chatId,
                `⚠️ <b>该图片已存在于图库中（已自动去重）</b>\n\n` +
                `🔗 <b>文件ID</b>: <code>${existingFileId}</code>`,
                { parse_mode: 'HTML' }
            );
        }
        return { success: false, reason: 'already_saved', existingFileId };
    }

    // 若为原图文档且尚无精准尺寸，流式读取前 64KB 二进制解析真实原始宽高
    if (message.document && fileType.startsWith('image/')) {
        try {
            const headerBuffer = await telegramAPI.getFileHeader(fileId, 65536);
            if (headerBuffer) {
                const dimensions = parseImageDimensions(headerBuffer);
                if (dimensions && dimensions.width && dimensions.height) {
                    width = dimensions.width;
                    height = dimensions.height;
                }
            }
        } catch (err) {
            console.error('[TelegramBot] Failed to parse document image dimensions:', err);
        }
    }

    // ==================== 5. 极速生成 ID（纯数学计算，零查库） ====================
    const ext = getQuickExtension(fileName, fileType);
    const uniqueIndex = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const fullId = uploadDir ? `${uploadDir}/${uniqueIndex}.${ext}` : `${uniqueIndex}.${ext}`;
    const directory = uploadDir ? `${uploadDir}/` : '';

    const metadata = {
        Channel: 'TelegramNew',
        ChannelName: channel.name || config.targetChannel,
        TgFileId: fileId,
        TgFileUniqueId: fileUniqueId || null,
        TgChatId: chatId,
        TgBotToken: channel.botToken,
        FileName: fileName,
        FileType: fileType,
        FileSize: (fileSize / 1024 / 1024).toFixed(2),
        FileSizeBytes: fileSize,
        UploadIP: 'Bot',
        TimeStamp: Date.now(),
        Label: 'None',
        Directory: directory,
        Tags: [],
        MediaGroupId: mediaGroupId
    };
    if (width && height) {
        metadata.Width = width;
        metadata.Height = height;
    }
    if (channel.proxyUrl) {
        metadata.TgProxyUrl = channel.proxyUrl;
    }

    // ==================== 6. 并行原子写入（主记录 + 去重指纹 + 前端索引通知） ====================
    try {
        await Promise.all([
            db.put(fullId, '', { metadata }),
            db.saveTgDedup(fileUniqueId, fileId, fullId),
            addFileToIndex(context, fullId, metadata)
        ]);
    } catch (error) {
        console.error('[TelegramBot] Failed to persist file:', error);
        return { success: false, reason: 'database_error', error: error.message };
    }

    // ==================== 7. 响应处理（单图秒回，组图滑动窗口聚合） ====================
    if (mediaGroupId) {
        const batchKey = `tg_batch_${chatId}_${mediaGroupId}`;
        const existingBatchRaw = await db.get(batchKey);

        let isLeader = false;
        let initialMsgId = null;

        if (!existingBatchRaw) {
            // 首图：作为 Leader 立即建立批次状态占位，杜绝并发网络耗时导致的裂脑竞争
            isLeader = true;
            const initialState = {
                messageId: null,
                firstFileId: fullId,
                files: [{ id: fullId, size: metadata.FileSize }],
                lastActive: Date.now(),
                completed: false
            };
            await db.put(batchKey, JSON.stringify(initialState));

            // 数据库占位写入完成后，再异步发送接收提示并安全回填 messageId
            try {
                const sendRes = await telegramAPI.sendMessage(
                    chatId,
                    `📥 <b>正在接收图集...</b>`,
                    { parse_mode: 'HTML' }
                );
                if (sendRes?.ok) {
                    initialMsgId = sendRes.result.message_id;
                    const latestRaw = await db.get(batchKey);
                    if (latestRaw) {
                        try {
                            const latestState = JSON.parse(latestRaw);
                            latestState.messageId = initialMsgId;
                            await db.put(batchKey, JSON.stringify(latestState));
                        } catch (_) {}
                    }
                }
            } catch (_) {}
        } else {
            // 后续图片到达：追加图片并刷新活跃时间戳
            let state;
            try { state = JSON.parse(existingBatchRaw); } catch (_) { state = { files: [] }; }
            state.files = state.files || [];
            state.files.push({ id: fullId, size: metadata.FileSize });
            state.lastActive = Date.now();

            // 如果该批次已经早早发过完成卡片（极端迟到慢图到达），直接原地编辑更新原消息，绝不新开卡片！
            if (state.completed && state.messageId) {
                const count = state.files.length;
                const totalSize = state.files.reduce((acc, f) => acc + (parseFloat(f.size) || 0), 0).toFixed(2);
                const dirDisplay = uploadDir ? `/${uploadDir}/` : '/';
                const updatedSummary =
                    `✅ <b>批量图集保存完成</b>\n\n` +
                    `📦 <b>保存总数</b>: ${count} 张\n` +
                    `📊 <b>总计大小</b>: ${totalSize} MB\n` +
                    `📁 <b>存放目录</b>: <code>${dirDisplay}</code>\n` +
                    `🔗 <b>首个文件</b>: <code>${state.firstFileId}</code>`;
                context.waitUntil(telegramAPI.editMessageText(chatId, state.messageId, updatedSummary, { parse_mode: 'HTML' }));
            }

            await db.put(batchKey, JSON.stringify(state));
        }

        // Leader 启动滑动窗口防抖监听器（Sliding Window Debounce）
        if (isLeader) {
            context.waitUntil((async () => {
                const IDLE_THRESHOLD_MS = 2200; // 在最后一张图到达后，连续静默 2.2 秒才算齐
                const POLL_INTERVAL_MS = 600;   // 每 600ms 检查一次活跃时间
                const MAX_TIMEOUT_MS = 45000;   // 容忍整个组图最长 45 秒传输时间
                const startTime = Date.now();

                try {
                    while (Date.now() - startTime < MAX_TIMEOUT_MS) {
                        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));

                        const currentRaw = await db.get(batchKey);
                        if (!currentRaw) break;

                        let currentState;
                        try { currentState = JSON.parse(currentRaw); } catch (_) { break; }

                        const idleTime = Date.now() - (currentState.lastActive || 0);

                        // 只有距离最后一张图片的进入时间超过了 2.2 秒静默，才代表组图全部到齐！
                        if (idleTime >= IDLE_THRESHOLD_MS) {
                            const count = currentState.files ? currentState.files.length : 1;
                            const totalSize = (currentState.files || []).reduce(
                                (acc, item) => acc + (parseFloat(item.size) || 0), 0
                            ).toFixed(2);
                            const dirDisplay = uploadDir ? `/${uploadDir}/` : '/';

                            const summaryText =
                                `✅ <b>批量图集保存完成</b>\n\n` +
                                `📦 <b>保存总数</b>: ${count} 张\n` +
                                `📊 <b>总计大小</b>: ${totalSize} MB\n` +
                                `📁 <b>存放目录</b>: <code>${dirDisplay}</code>\n` +
                                `🔗 <b>首个文件</b>: <code>${currentState.firstFileId}</code>`;

                            const targetMsgId = currentState.messageId || initialMsgId;
                            if (targetMsgId) {
                                await telegramAPI.editMessageText(chatId, targetMsgId, summaryText, { parse_mode: 'HTML' });
                            } else {
                                await telegramAPI.sendMessage(chatId, summaryText, { parse_mode: 'HTML' });
                            }

                            // 标记为 completed，保留 60 秒用于兜底极迟到的慢图（60秒后自动过期或清理）
                            currentState.completed = true;
                            await db.put(batchKey, JSON.stringify(currentState));
                            return;
                        }
                    }
                } catch (err) {
                    console.error('[TelegramBot] Batch debouncer failed:', err);
                }
            })());
        }
    } else {
        // 单图模式：直接秒回
        const dirDisplay = uploadDir ? `/${uploadDir}/` : '/';
        const dimensionInfo = (metadata.Width && metadata.Height)
            ? `📐 <b>尺寸</b>: ${metadata.Width} × ${metadata.Height}\n`
            : '';
        await telegramAPI.sendMessage(
            chatId,
            `✅ <b>图片保存成功</b>\n\n` +
            `📁 <b>存放目录</b>: <code>${dirDisplay}</code>\n` +
            `📊 <b>大小</b>: ${metadata.FileSize} MB\n` +
            dimensionInfo +
            `🔗 <b>文件ID</b>: <code>${fullId}</code>`,
            { parse_mode: 'HTML' }
        );
    }

    return {
        success: true,
        fileId: fullId,
        metadata,
        mediaGroupId
    };
}
