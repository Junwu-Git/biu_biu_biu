#!/bin/sh

# 设置 -e 会在任何命令失败时立即退出脚本
set -e

# 从环境变量获取期望的用户ID和组ID，如果未设置则默认为 1000
TARGET_UID=${TARGET_UID:-1000}
TARGET_GID=${TARGET_GID:-1000}

# 获取容器内 'user' 用户当前的 UID 和 GID
CURRENT_UID=$(id -u user)
CURRENT_GID=$(id -g user)

echo "启动 entrypoint 脚本..."
echo "主机用户期望 UID: ${TARGET_UID}, GID: ${TARGET_GID}"
echo "容器内当前 user 的 UID: ${CURRENT_UID}, GID: ${CURRENT_GID}"

# 只有当期望的ID与当前的ID不同时，才进行修改
if [ "$CURRENT_UID" != "$TARGET_UID" ] || [ "$CURRENT_GID" != "$TARGET_GID" ]; then
    echo "ID不匹配，正在修改容器内 user 的 UID/GID..."
    # 修改组ID
    groupmod -o -g "$TARGET_GID" user
    # 修改用户ID
    usermod -o -u "$TARGET_UID" user
    echo "UID/GID 修改完成。"
else
    echo "ID已匹配，无需修改。"
fi

# 修复挂载卷的权限，确保 'user' 用户可以写入
# chown 会将目录的所有权递归地赋予我们刚刚修正过ID的 'user'
echo "正在修复挂载目录的所有权..."
# 确保目录存在再执行 chown，这样更健壮
[ -d /app/auth ] && chown -R user:user /app/auth
[ -d /app/debug-screenshots ] && chown -R user:user /app/debug-screenshots
echo "权限修复完成。"

# 最后，以 'user' 用户的身份执行传递给脚本的命令（即 CMD）
echo "切换到 'user' 并执行主命令: $@"
exec gosu user "$@"