/**
 * Telegram API 封装类
 */
export class TelegramAPI {
    constructor(botToken, proxyUrl = '') {
        this.botToken = botToken;
        this.proxyUrl = proxyUrl;
        // 如果设置了代理域名，使用代理域名，否则使用官方 API
        const apiDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
        this.baseURL = `${apiDomain}/bot${this.botToken}`;
        this.fileDomain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
        this.defaultHeaders = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0"
        };
    }

    /**
     * 发送文件到Telegram
     * @param {File} file - 要发送的文件
     * @param {string} chatId - 聊天ID
     * @param {string} functionName - API方法名（如：sendPhoto, sendDocument等）
     * @param {string} functionType - 文件类型参数名（如：photo, document等）
     * @returns {Promise<Object>} API响应结果
     */
    async sendFile(file, chatId, functionName, functionType, caption = '', fileName = '') {
        const formData = new FormData();

        formData.append('chat_id', chatId);
        if (fileName) {
            formData.append(functionType, file, fileName);
        } else {
            formData.append(functionType, file);
        }
        if (caption) {
            formData.append('caption', caption);
        }

        const response = await fetch(`${this.baseURL}/${functionName}`, {
            method: 'POST',
            headers: this.defaultHeaders,
            body: formData
        });
        console.log('Telegram API response:', response.status, response.statusText);
        if (!response.ok) {
            throw new Error(`Telegram API error: ${response.statusText}`);
        }

        // 解析响应数据
        const responseData = await response.json();

        return responseData;
    }

    /**
     * 获取文件信息
     * @param {Object} responseData - Telegram API响应数据
     * @returns {Object|null} 文件信息对象或null
     */
    getFileInfo(responseData) {
        const getFileDetails = (file) => ({
            file_id: file.file_id,
            file_name: file.file_name || file.file_unique_id,
            file_size: file.file_size,
        });

        try {
            if (!responseData.ok) {
                console.error('Telegram API error:', responseData.description);
                return null;
            }

            if (responseData.result.photo) {
                const largestPhoto = responseData.result.photo.reduce((prev, current) =>
                    (prev.file_size > current.file_size) ? prev : current
                );
                return getFileDetails(largestPhoto);
            }

            if (responseData.result.video) {
                return getFileDetails(responseData.result.video);
            }

            if (responseData.result.audio) {
                return getFileDetails(responseData.result.audio);
            }

            if (responseData.result.document) {
                return getFileDetails(responseData.result.document);
            }

            return null;
        } catch (error) {
            console.error('Error parsing Telegram response:', error.message);
            return null;
        }
    }

    /**
     * 获取文件路径
     * @param {string} fileId - 文件ID
     * @returns {Promise<string|null>} 文件路径或null
     */
    async getFilePath(fileId) {
        try {
            const url = `${this.baseURL}/getFile?file_id=${fileId}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: this.defaultHeaders,
            });

            const responseData = await response.json();
            if (responseData.ok) {
                return responseData.result.file_path;
            } else {
                return null;
            }
        } catch (error) {
            console.error('Error getting file path:', error.message);
            return null;
        }
    }

    /**
     * 获取文件内容
     * @param {string} fileId - 文件ID
     * @returns {Promise<Response>} 文件响应
     */
    async getFileContent(fileId) {
        const filePath = await this.getFilePath(fileId);
        if (!filePath) {
            throw new Error(`File path not found for fileId: ${fileId}`);
        }

        const fullURL = `${this.fileDomain}/file/bot${this.botToken}/${filePath}`;
        const response = await fetch(fullURL, {
            headers: this.defaultHeaders
        });

        return response;
    }

    /**
     * 获取文件头部二进制数据（用于极速解析原图/文档图片的宽高尺寸，避免全量下载大文件）
     * @param {string} fileId - Telegram 文件 ID
     * @param {number} bytes - 需要获取的最大头部字节数（默认 64KB）
     * @returns {Promise<ArrayBuffer|null>} 文件头部 ArrayBuffer 或 null
     */
    async getFileHeader(fileId, bytes = 65536) {
        try {
            const filePath = await this.getFilePath(fileId);
            if (!filePath) return null;

            const fullURL = `${this.fileDomain}/file/bot${this.botToken}/${filePath}`;
            const response = await fetch(fullURL, {
                headers: {
                    ...this.defaultHeaders,
                    Range: `bytes=0-${bytes - 1}`
                }
            });

            if (!response.ok && response.status !== 206) {
                return null;
            }

            if (!response.body) {
                const buf = await response.arrayBuffer();
                return buf.slice(0, bytes);
            }

            const reader = response.body.getReader();
            const chunks = [];
            let totalRead = 0;

            while (totalRead < bytes) {
                const { done, value } = await reader.read();
                if (done || !value) break;
                chunks.push(value);
                totalRead += value.length;
            }

            try {
                await reader.cancel();
            } catch (_) {}

            const combined = new Uint8Array(totalRead);
            let offset = 0;
            for (const chunk of chunks) {
                combined.set(chunk, offset);
                offset += chunk.length;
            }
            return combined.buffer;
        } catch (error) {
            console.error('Error fetching file header:', error);
            return null;
        }
    }

    /**
     * 发送文本消息
     * @param {string} chatId - 聊天ID
     * @param {string} text - 消息文本
     * @param {Object} options - 可选参数
     * @returns {Promise<Object>} API响应结果
     */
    async sendMessage(chatId, text, options = {}) {
        const url = `${this.baseURL}/sendMessage`;
        const body = {
            chat_id: chatId,
            text: text,
            ...options
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...this.defaultHeaders,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        return await response.json();
    }

    /**
     * 设置 Webhook
     * @param {string} webhookUrl - Webhook URL
     * @param {string} secretToken - 验证 token
     * @returns {Promise<Object>} API响应结果
     */
    async setWebhook(webhookUrl, secretToken) {
        const url = `${this.baseURL}/setWebhook`;
        const body = {
            url: webhookUrl,
            secret_token: secretToken
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...this.defaultHeaders,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        return await response.json();
    }

    /**
     * 删除 Webhook
     * @returns {Promise<Object>} API响应结果
     */
    async deleteWebhook() {
        const url = `${this.baseURL}/deleteWebhook`;
        const response = await fetch(url, {
            method: 'POST',
            headers: this.defaultHeaders
        });

        return await response.json();
    }

    /**
     * 获取 Webhook 信息
     * @returns {Promise<Object>} API响应结果
     */
    async getWebhookInfo() {
        const url = `${this.baseURL}/getWebhookInfo`;
        const response = await fetch(url, {
            method: 'GET',
            headers: this.defaultHeaders
        });

        return await response.json();
    }

    /**
     * 编辑消息
     * @param {string} chatId - 聊天ID
     * @param {number} messageId - 消息ID
     * @param {string} text - 新消息文本
     * @param {Object} options - 可选参数
     * @returns {Promise<Object>} API响应结果
     */
    async editMessageText(chatId, messageId, text, options = {}) {
        const url = `${this.baseURL}/editMessageText`;
        const body = {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            ...options
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                ...this.defaultHeaders,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(body)
        });

        return await response.json();
    }

}