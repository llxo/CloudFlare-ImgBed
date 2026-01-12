import { getDatabase } from '../../../utils/databaseAdapter.js';
import { TelegramAPI } from '../../../utils/telegramAPI.js';

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
 * Telegram Bot Webhook 管理 API
 * 支持设置、删除、查询 Webhook
 */
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const db = getDatabase(env);

    // GET 方法：查询 Webhook 状态或配置
    if (request.method === 'GET') {
        const action = url.searchParams.get('action');

        if (action === 'getWebhookInfo') {
            // 查询 Telegram Webhook 状态
            return await getWebhookInfo(db, env);
        } else {
            // 获取本地 Webhook 配置
            return await getWebhookConfig(db);
        }
    }

    // POST 方法：设置或删除 Webhook
    if (request.method === 'POST') {
        const body = await request.json();
        const action = body.action;

        if (action === 'setWebhook') {
            return await setWebhook(db, env, body);
        } else if (action === 'deleteWebhook') {
            return await deleteWebhook(db, env);
        } else if (action === 'saveConfig') {
            return await saveWebhookConfig(db, body);
        } else {
            return new Response(JSON.stringify({ error: 'Invalid action' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    return new Response('Method not allowed', { status: 405 });
}

/**
 * 获取本地 Webhook 配置
 */
async function getWebhookConfig(db) {
    try {
        const configStr = await db.get('manage@sysConfig@telegram@webhook');
        const config = configStr ? JSON.parse(configStr) : {
            enabled: false,
            secretToken: '',
            targetChannel: ''
        };

        return new Response(JSON.stringify(config), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 保存 Webhook 配置
 */
async function saveWebhookConfig(db, body) {
    try {
        const config = {
            enabled: body.enabled || false,
            secretToken: body.secretToken || '',
            targetChannel: body.targetChannel || ''
        };

        await db.put('manage@sysConfig@telegram@webhook', JSON.stringify(config));

        return new Response(JSON.stringify({ success: true, config }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 设置 Telegram Webhook
 */
async function setWebhook(db, env, body) {
    try {
        const { webhookUrl, secretToken, targetChannel } = body;

        if (!webhookUrl || !secretToken || !targetChannel) {
            return new Response(JSON.stringify({
                error: 'Missing required parameters: webhookUrl, secretToken, targetChannel'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 获取目标渠道配置
        const channelConfig = await getTelegramChannel(db, targetChannel);
        if (!channelConfig) {
            return new Response(JSON.stringify({
                error: `Channel not found: ${targetChannel}`
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const botToken = channelConfig.botToken;
        const proxyUrl = channelConfig.proxyUrl || '';

        if (!botToken) {
            return new Response(JSON.stringify({
                error: 'Bot token not found in channel config'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // 调用 Telegram API 设置 Webhook
        const telegramAPI = new TelegramAPI(botToken, proxyUrl);
        const result = await telegramAPI.setWebhook(webhookUrl, secretToken);

        if (result.ok) {
            // 保存配置到数据库
            const config = {
                enabled: true,
                secretToken,
                targetChannel
            };
            await db.put('manage@sysConfig@telegram@webhook', JSON.stringify(config));

            return new Response(JSON.stringify({
                success: true,
                result,
                config
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            return new Response(JSON.stringify({
                success: false,
                error: result.description || 'Failed to set webhook'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 删除 Telegram Webhook
 */
async function deleteWebhook(db, env) {
    try {
        // 获取当前配置
        const configStr = await db.get('manage@sysConfig@telegram@webhook');
        if (!configStr) {
            return new Response(JSON.stringify({
                error: 'Webhook not configured'
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const config = JSON.parse(configStr);
        const targetChannel = config.targetChannel;

        // 获取目标渠道配置
        const channelConfig = await getTelegramChannel(db, targetChannel);
        if (!channelConfig) {
            return new Response(JSON.stringify({
                error: `Channel not found: ${targetChannel}`
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const botToken = channelConfig.botToken;
        const proxyUrl = channelConfig.proxyUrl || '';

        // 调用 Telegram API 删除 Webhook
        const telegramAPI = new TelegramAPI(botToken, proxyUrl);
        const result = await telegramAPI.deleteWebhook();

        if (result.ok) {
            // 更新配置（禁用 Webhook）
            config.enabled = false;
            await db.put('manage@sysConfig@telegram@webhook', JSON.stringify(config));

            return new Response(JSON.stringify({
                success: true,
                result
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        } else {
            return new Response(JSON.stringify({
                success: false,
                error: result.description || 'Failed to delete webhook'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

/**
 * 查询 Telegram Webhook 状态
 */
async function getWebhookInfo(db, env) {
    try {
        // 获取当前配置
        const configStr = await db.get('manage@sysConfig@telegram@webhook');
        if (!configStr) {
            return new Response(JSON.stringify({
                error: 'Webhook not configured'
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const config = JSON.parse(configStr);
        const targetChannel = config.targetChannel;

        // 获取目标渠道配置
        const channelConfig = await getTelegramChannel(db, targetChannel);
        if (!channelConfig) {
            return new Response(JSON.stringify({
                error: `Channel not found: ${targetChannel}`
            }), {
                status: 404,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const botToken = channelConfig.botToken;
        const proxyUrl = channelConfig.proxyUrl || '';

        // 调用 Telegram API 查询 Webhook 状态
        const telegramAPI = new TelegramAPI(botToken, proxyUrl);
        const result = await telegramAPI.getWebhookInfo();

        return new Response(JSON.stringify({
            success: true,
            localConfig: config,
            telegramInfo: result
        }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
