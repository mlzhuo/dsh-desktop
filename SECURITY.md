# 安全政策：凭据与机密

## 政策

**新增凭据一律放 `~/.dsh` 或环境变量，仓库内只写占位符。**

- API key、令牌、密码等机密**永不提交到 git**；
- 仓库中只允许出现占位符形态，例如 `DEEPSEEK_API_KEY=sk-…`、`sk-your-key-here`、`<your-key>`；
- 真实数据（实际会话、`~/.dsh` 下的凭据文件）位于仓库之外，不会被跟踪。

## 凭据放哪里

| 用途 | 存放位置 | 说明 |
|---|---|---|
| DSH 运行时凭据（API key 等） | `~/.dsh/credentials.yaml` | DSH 数据目录，仓库外 |
| 单次 / 按环境覆盖 | 环境变量（如 `DEEPSEEK_API_KEY`） | 可被 DSH 按次读取 |
| CI 构建 / 测试 | GitHub Actions Secrets | 仓库中只引用 `${{ secrets.* }}`，不写值 |

## 仓库内的防护

1. **根 `.gitignore`**：忽略 `.env*`（`.env.example` 除外）、私钥、证书、密钥库、会话数据库——防止误 `git add`；
2. **提交前扫描钩子**（`.githooks/pre-commit`）：暂存时自动拦截敏感文件名与高置信度机密特征（GitHub token、AWS AKIA、私钥、JWT、长 `sk-` 串等）；
   - 本机已配置 `git config core.hooksPath .githooks`；**新克隆的仓库需手动执行一次**：
     ```bash
     git config core.hooksPath .githooks
     ```
   - 紧急绕过：`git commit --no-verify`（绕过后请立即清理误提交内容）；
   - 测试夹具里的假 key（如 `sk-e2efixture1234567890`）不受影响。

## 泄漏处置

一旦发现真实密钥被提交：

1. **立即轮换 / 吊销**该密钥（在 DeepSeek 控制台或对应服务商处）；
2. 从 git 历史中清除：`git filter-repo` 或重写历史后 `push --force-with-lease`；
3. 检查 CI 日志、fork、克隆过该仓库的其他机器是否已获取到该值。
