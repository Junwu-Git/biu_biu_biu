# AI Studio Build App Reverse Proxy

这是一个为 Google AI Studio 的 "Build App" 功能设计的反向代理项目。它允许您通过 API 的方式，调用和使用在 AI Studio 中构建的应用模型。

本项目使用 Playwright 自动化浏览器操作。

---

## 🚀 项目特点

本项目专注于 **Docker 容器化部署**，并在原项目的基础上，利用 AI 进行了深度定制和功能增强，旨在提供一个**更健壮、更稳定、更易于维护**的生产级解决方案。

> **免责声明**: 本仓库的所有代码修改均由 AI 生成，旨在探索自动化编程与应用优化的可能性。请在充分理解代码功能和潜在风险的基础上酌情使用，作者对可能产生的任何问题概不负责。

---

###  🚀Quick Start / 快速开始

要快速启动并运行此项目，请遵循以下步骤。

1.  📝 **准备 `docker-compose.yml` 文件**:
    在项目根目录创建 `docker-compose.yml`，并粘贴以下内容：
    ```yaml
    version: '3.8'

    services:
      biu_biu_biu:
        image: ghcr.io/junwu-git/biu_biu_biu:latest
        container_name: biu_biu_biu
        restart: unless-stopped
        ports:
          - "8889:8889"
        env_file:
          - .env
        deploy:
          resources:
            limits:
              memory: 1024M
        volumes:
          - ./auth:/app/auth
          - ./debug-screenshots:/app/debug-screenshots
        networks:
          - internal-redis-network # 确保 biu_biu_biu 可以访问到 redis-server

      # Redis 服务
      redis-server:
        image: redis:latest 
        container_name: redis
        restart: always
        command: redis-server --appendonly yes # 启用持久化 (可选，但推荐)
        volumes:
          - ./data:/data # 数据持久化
        networks:
          - internal-redis-network # 连接到内部网络，与 biu_biu_biu 通信
        # ports: # Redis 通常不需要对外暴露端口，但如果需要，可以取消注释
        #   - "6379:6379" 

    networks:
      internal-redis-network: # 内部网络，用于 biu_biu_biu 和 redis-server 通信
        driver: bridge

    ```

3.  🔑 **准备 `.env` 文件**:
    在项目根目录创建 `.env` 文件，并粘贴以下内容。请**务必替换 `API_KEYS`** 为您的实际密钥。
    ```env
    # =================================================================
    # ===================         核心配置         ===================
    # =================================================================

    # --- 用户与权限 (Docker) ---
    # 描述: 用于 Docker 容器内文件权限的映射。
    # 用法: 在你的主机上运行 `id -u` 和 `id -g` 来获取值。
    # TARGET_UID=1001
    # TARGET_GID=1001

    # --- API 密钥 (安全) ---
    # 描述: 用于保护代理服务的访问密钥，多个密钥用英文逗号分隔。
    # 示例: API_KEYS=key1,key2,key3
    API_KEYS=your_secret_api_key_here

    # --- 服务器监听配置 ---
    # 描述: 代理服务器监听的端口和主机地址。
    # PORT=8889
    # HOST=0.0.0.0

    # =================================================================
    # ===================         功能配置         ===================
    # =================================================================

    # --- 调试与流式模式 ---
    # 描述: 开启或关闭调试模式，以及设置响应模式 ('real' 或 'fake')。
    # DEBUG_MODE=false
    # STREAMING_MODE=real

    # --- 账号切换与重试策略 ---
    # 描述: 配置服务在遇到错误时的行为。
    # FAILURE_THRESHOLD=0                 # 连续失败多少次后切换账号 (0为禁用)。
    # MAX_RETRIES=3                       # 单个请求的最大重试次数。
    # RETRY_DELAY=3000                    # 每次重试之间的延迟 (毫秒)。
    # INITIAL_AUTH_INDEX=1                # 初始启动时使用的账号索引 (从1开始)。
    # IMMEDIATE_SWITCH_STATUS_CODES=429,503 # 哪些HTTP状态码会立即触发账号切换。

    # --- Redis 缓存 (可选) ---
    # 描述: 用于缓存请求结果，减少重复调用。如果未设置 REDIS_URL，则禁用缓存。
    # REDIS_URL=redis://redis:6379/0      # Redis 连接 URL。
    # CACHE_TTL=300                       # 缓存有效期 (秒)。

    # =================================================================
    # ===================       浏览器自动化配置       ===================
    # =================================================================

    # --- 自动化目标 (JSON格式) ---
    # 描述: 这是一个 JSON 字符串，定义了浏览器自动化操作的目标。
    # 注意: 请确保这是一个单行的、合法的 JSON 字符串。
    # AUTOMATION_TARGETS_JSON={"targetUrl":"https://aistudio.google.com/u/0/apps/bundled/blank?showAssistant=true&showCode=true","popupCloseButtons":["button:has-text('Got it')","button:has-text('✕')","button:has-text('close')"],"codeButtonClick":{"role":"button","name":"Code","exact":true},"editorSelector":"div.monaco-editor","previewButton":{"role":"button","name":"Preview"}}
    ```

4.  📁 **创建本地目录与准备认证文件**:
    在项目根目录中，创建 `auth` 和 `debug-screenshots` 目录。
    ```bash
    mkdir auth debug-screenshots
    chmod 777 debug-screenshots # 确保容器有权限写入调试截图
    ```
    本项目依赖于浏览器认证文件。您可以通过运行 `save-auth.js` 脚本来生成这些文件。完成登录后，生成的 `auth-X.json` 文件会自动保存在 `auth` 目录中。

5.  🚀 **启动服务**:
    ```bash
    docker-compose up -d
    ```
