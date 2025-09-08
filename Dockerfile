# 最终推荐的 Dockerfile
# 它融合了版本B的高效分层和您现有的entrypoint权限管理方案

# 1. 使用稳定、轻量的基础镜像
FROM node:18-slim

# 2. 将工作目录设置得更通用
WORKDIR /app

# 3. [来自您的Dockerfile] 拷贝并设置入口脚本
# 这是固定不变的，放在前面
COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh

# 4. [来自Dockerfile(B)] 安装几乎不会改变的系统依赖
RUN apt-get update && apt-get install -y \
    curl gosu \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libx11-6 \
    libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 \
    libxrandr2 libxss1 libxtst6 xvfb \
    && rm -rf /var/lib/apt/lists/*

# 5. [来自Dockerfile(B)] 安装项目依赖
# 只有 package.json 变动时，这一层才会重新执行
COPY package.json ./
RUN npm install

# 6. [来自Dockerfile(B)] 下载并准备 Camoufox
# 只有 CAMOUFOX_URL 变化时，才会重新下载
COPY camoufox-linux /app/camoufox-linux
RUN chmod +x /app/camoufox-linux/camoufox

# 7. [来自Dockerfile(B)的优化] 最后才拷贝经常变动的应用代码
# 注意：我们只拷贝需要的文件，而不是用 "COPY . ."
COPY unified-server.js ./
COPY dark-browser.js ./

# 8. [来自您的Dockerfile] 创建一个低权限用户，供 entrypoint.sh 使用
# 'gosu' 将在容器启动时处理权限切换
RUN adduser --disabled-password --gecos "" user

# 9. 暴露您在 docker-compose.yml 中定义的端口
EXPOSE 8889

# 10. 定义入口点，执行权限管理脚本
ENTRYPOINT ["entrypoint.sh"]

# 11. 定义容器默认执行的命令
CMD ["node", "unified-server.js"]
