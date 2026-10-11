# MicroLend 小组交接与后续操作指南

更新日期：2026-10-11。适用于当前 Sepolia + Render 部署。本文汇总已完成工作、公开地址、配置、密钥交接方式和接下来的测试任务。

**目前已经完成合约部署和网站上线，可以进入业务测试；完整借贷闭环尚未验收。** 组员使用自己的 MetaMask 钱包即可测试。继续使用现有五个合约，不要为了接手重新运行 Sepolia 部署命令。

## 1. 先看这三件事

1. 打开 [线上网站](https://microlend-web.onrender.com)，安装 MetaMask、切换到 Sepolia、连接钱包并签名登录。普通组员不需要获取部署私钥，也不需要先安装开发环境。
2. **团队仓库是 `catjlx/microlend`，但当前前后端 Render 服务都连接 `Garywong007/microlend` 的 `main` 分支。** 这是部署员在 2026-10-11 查看设置后确认的。团队仓库合并代码后，需要同步到 Gary 的 `main` 才能更新线上服务，见第 8 节。
3. **本仓库公开。** 本文提供公开地址和完整密钥清单，但不包含真实钱包私钥、助记词、带 Key 的 RPC URL、数据库密码或 JWT 密钥。这些值由当前部署员和对应平台账号管理员私下交接，不能贴进 GitHub 文件、Issue、PR 或截图。

## 2. 已完成工作及验证范围

| 工作 | 当前状态 | 依据或边界 |
|---|---|---|
| Solidity 合约、React 前端、Express 后端、评分模型 | 代码已有 | 见 `contracts/`、`frontend/`、`backend/`、`ml/` |
| 合约编译与自动化测试 | 此前本地验证通过 | Windows Node 22 环境：合约 49/49、后端 16/16、前端构建成功；本次交接未重跑这些测试 |
| Gas、覆盖率、Slither、模型及模拟结果 | 仓库已有证据 | 见 [测试说明](TESTING.md)、[安全说明](SECURITY.md)、[Slither 分析](SLITHER_TRIAGE.md) 和 `docs/evidence/`；仍需整理成报告 |
| 五个合约部署及初始角色授予 | 已完成 | [部署元数据](../deployments/sepolia.json)、[部署日志](evidence/11-deploy-sepolia.txt) |
| Etherscan 源码验证 | 部署日志报告五个成功 | 此前独立查看确认 MockStablecoin 为 Exact Match；其余合约仍应逐个截图留证 |
| 部署结果提交团队仓库 | 已完成 | [PR #1](https://github.com/catjlx/microlend/pull/1) 已合并；本次交接基于主分支 `1b5496f9809717096c159e942e065d8819f4f40f` |
| Render 前端及 API 上线 | 已完成并复查 | 两个公开网站可访问，前端构建使用正确的 API 地址 |
| CORS 与事件同步修复 | 已完成并复查 | CORS 允许当前前端；部署员已设置 `INDEXER_CHUNK=10`，最近同步检查无错误 |
| 部署钱包登录、Admin / Officer / Audit 页面 | 部署员反馈成功 | 属于人工操作反馈，本次未代替钱包签名或发交易 |
| 为实际组员授予 Officer / Auditor | 待确认 | 部署文件里的初始角色仍是部署钱包；文件不会自动记录后续角色变更 |
| Sepolia 借贷闭环、异常场景、交易证据 | 待执行 | 最新公开统计为贷款 0、评分请求 0；上线不等于业务验收完成 |
| 报告、幻灯片、10 分钟视频、个人贡献报告 | 待整理或完成 | 以课程正式要求为准，本文按团队指南与仓库报告指南安排 |

### 最近一次线上检查

2026-10-11 本次交接过程中复查：

| 检查项 | 结果 |
|---|---|
| 前端与入口 JS | HTTP 200；入口 `/assets/index-CTDzI1Zy.js` 包含正确 API 地址 |
| `/api/health`、`/api/config`、`/api/stats` | 全部 HTTP 200 |
| 网络 | `sepolia`，chainId `11155111` |
| CORS | `https://microlend-web.onrender.com` |
| 索引进度 | lastBlock `11892697`、head `11892699`、lag `2`、error `null`；区块数字会继续变化 |
| 贷款与评分 | 贷款 `0`、评分请求 `0`，符合尚未开始业务测试的阶段 |

此检查只验证网站与 API 连接、配置和同步状态，没有发起贷款、审批、还款或授权交易。

## 3. 所有公开入口

| 地址 | 用途 |
|---|---|
| [团队仓库 catjlx/microlend](https://github.com/catjlx/microlend) | 小组代码评审、合并和最终提交的共同仓库 |
| [当前部署仓库 Garywong007/microlend](https://github.com/Garywong007/microlend) | 两个 Render 服务实际读取的源码，分支 `main` |
| [前端](https://microlend-web.onrender.com) | 用户操作入口，含 Overview、Borrow、Lend、角色页面 |
| [后端](https://microlend-api.onrender.com) | API 基础地址；首页本身不必展示网页 |
| [健康检查](https://microlend-api.onrender.com/api/health) | 查看网络、chainId、indexer.error 和同步 lag |
| [公开配置](https://microlend-api.onrender.com/api/config) | 查看运行中的合约地址、SCORER 地址和模型信息 |
| [ABI](https://microlend-api.onrender.com/api/abis) | 前端调用合约所需的接口定义 |
| [统计](https://microlend-api.onrender.com/api/stats) | 资金池、贷款、评分统计 |
| [资金池历史](https://microlend-api.onrender.com/api/pool/history) | 资金池图表数据 |
| [Render 控制台](https://dashboard.render.com) | 服务设置、环境变量、日志、部署和数据库管理；需要账号权限 |
| [Alchemy 控制台](https://dashboard.alchemy.com) | 后端 RPC App、额度和 API Key 管理；需要账号权限 |
| [MetaMask 官网](https://metamask.io/zh-CN) | 安装钱包；连接、登录签名、确认链上交易 |
| [Sepolia Etherscan](https://sepolia.etherscan.io) | 查询合约源码、交易结果、事件、Gas |
| [Google Sepolia 水龙头](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) | 领取付 Gas 用的测试 ETH；领取资格以页面要求为准 |

基本配合方式：GitHub 保存代码；Render 从部署仓库构建前端和 API；API 通过 RPC 读取 Sepolia 并把事件写入数据库；浏览器通过 MetaMask 发起用户交易；Etherscan 提供交易及源码证据。评分在后端计算，SCORER 签署评分证明，借款人再把评分提交上链。

## 4. Sepolia 合约与钱包地址

网络：Ethereum Sepolia；chainId `11155111`（十六进制 `0xaa36a7`）；Gas 币为 Sepolia ETH。借贷使用 mUSDC 测试代币，mUSDC 不能支付 Gas。

部署时间：`2026-10-11T09:08:53.137Z`（UTC），即北京时间 2026-10-11 17:08:53。索引起始区块：`11890702`。

| 合约 | 地址与源码入口 | 职责 |
|---|---|---|
| MockStablecoin | [0x882b02C3eeaC59BC42C283c6C8d32BaA3723B2d1](https://sepolia.etherscan.io/address/0x882b02C3eeaC59BC42C283c6C8d32BaA3723B2d1#code) | mUSDC 测试币、领币与 ERC-20 授权；6 位小数 |
| CreditRegistry | [0xa80e874cA4C8C33b7c1887370005823f4cBe248F](https://sepolia.etherscan.io/address/0xa80e874cA4C8C33b7c1887370005823f4cBe248F#code) | 信用分、信用档案、分档、SCORER 权限 |
| LendingPool | [0x576358F66d8d521bcd02A472Ef87F903f1c4f410](https://sepolia.etherscan.io/address/0x576358F66d8d521bcd02A472Ef87F903f1c4f410#code) | 出借资金、份额、提取与风险储备 |
| CollateralVault | [0x9c7b61301E2573f0Ab52aA51669e496E1Cf10B31](https://sepolia.etherscan.io/address/0x9c7b61301E2573f0Ab52aA51669e496E1Cf10B31#code) | 抵押品托管、归还、违约扣押 |
| LoanManager | [0x9279A53E8E93cA960f682c3bAEd6cCC940aE0b69](https://sepolia.etherscan.io/address/0x9279A53E8E93cA960f682c3bAEd6cCC940aE0b69#code) | 申请、审批、放款、还款、违约、审计备注 |

| 钱包或角色 | 当前公开地址 | 交接说明 |
|---|---|---|
| DEPLOYER / 初始 Admin | `0xC0f1C1a59D70F3afD12776c86811664B08AeEC80` | 当前管理员操作钱包，需要测试 ETH |
| 初始 Officer | 同上 | 后续给实际信贷员组员的钱包授予角色；不能审批自己的申请 |
| 初始 Auditor | 同上 | 后续给实际审计员组员的钱包授予角色 |
| SCORER | `0xb5767eFeD7b6C51C4DD9484f9c545B96a60EB3dD` | 后端签署评分证明，需在 CreditRegistry 持有 `SCORER_ROLE`；只签名无需 Gas |
| 组员借款 / 出借钱包 | 各自新建，地址待组内登记 | 不需要管理员角色或共用私钥；每个发交易的钱包需测试 ETH |

合约地址由部署文件和运行中的 API 对照确认。角色表是部署时的初始记录；当前角色应以链上状态及登录后的页面为准。

## 5. 配置与密钥交接

### 5.1 Render 前端：microlend-web → Environment

```dotenv
VITE_API_URL=https://microlend-api.onrender.com
```

不要把前端地址填进该变量，也不要添加 `/api`，前端代码会自动添加它。修改后点击页面实际提供的 **Save and deploy**，等新构建成功，浏览器 `Ctrl+Shift+R` 刷新。`VITE_` 变量会进入公开的浏览器 JS，不能存私钥或其他凭证。

### 5.2 Render 后端：microlend-api → Environment

| 变量 | 值或获取方式 | 是否敏感 |
|---|---|---|
| `NODE_ENV` | `production` | 否 |
| `NETWORK` | `sepolia` | 否 |
| `RPC_URL` | 当前管理员在 Alchemy 创建的 Sepolia HTTP RPC；真实值只放控制台 | **是，URL 内含 API Key** |
| `PUBLIC_RPC_URL` | 使用不含 Key 的公开 Sepolia RPC，例如 `https://ethereum-sepolia-rpc.publicnode.com` | 否；此处为推荐值，实际控制台值仍需管理员核对 |
| `EXPLORER_URL` | `https://sepolia.etherscan.io` | 否 |
| `SCORER_PRIVATE_KEY` | 对应上表 SCORER 地址的私钥，由当前部署员私下管理 | **是** |
| `JWT_SECRET` | 生产环境至少 32 字符；Blueprint 可生成，保留现有值或受控轮换 | **是** |
| `CORS_ORIGIN` | `https://microlend-web.onrender.com`，无末尾斜杠和页面路径 | 否 |
| `INDEXER_CHUNK` | **`10`**；当前 RPC 配置曾拒绝默认 2000 区块范围的日志查询 | 否 |
| `DATABASE_URL` | 由 Render 数据库连接串绑定，含数据库凭证 | **是** |
| `DATABASE_SSL` | 同区域 Render 内网连接按现有 Blueprint 为 `false`；外部连接需按提供商配置 TLS | 否 |

**`INDEXER_CHUNK=10` 是已手工设置的线上配置，目前未写入 Blueprint 的 envVars。** 新建服务时必须补上；代码默认仍是 `2000`。不要仅凭 `health.ok=true` 判断成功，还要看 `indexer.error=null`、区块进度持续更新、lag 稳定。

`PUBLIC_RPC_URL` 在公开配置接口中返回。它不能复制带私人 Key 的 `RPC_URL`。Render 中保存环境变量不等于 GitHub 会保存它们，下载仓库也不会获得这些密钥。

### 5.3 部署用本地 .env

根目录 `.env` 为被 Git 忽略的配置文件。以下仅说明变量，尖括号内容不是可以直接执行的值：

```dotenv
SEPOLIA_RPC_URL=<私下保存的 Sepolia RPC URL>
DEPLOYER_PRIVATE_KEY=<部署钱包私钥>
SCORER_ADDRESS=0xb5767eFeD7b6C51C4DD9484f9c545B96a60EB3dD
ETHERSCAN_API_KEY=<验证源码用的 API Key>
```

部署已完成，接手测试无需填写该文件，更不需要再部署。修改根 `.env` 不会修改 Render 环境变量。

### 5.4 需要交接的敏感信息清单

| 信息 | 用途 | 当前应保存的位置 / 交接对象 |
|---|---|---|
| DEPLOYER 私钥或对应钱包备份 | 管理现有合约和授予角色 | 当前部署员的安全记录或钱包；只交给明确承担管理员职责的人 |
| SCORER 私钥 | 后端评分签名 | 当前部署员安全记录与 Render 后端 Environment；交给后端运维负责人 |
| Alchemy API Key / 私有 RPC URL | 后端读链、索引 | Alchemy App 与 Render；交给运维负责人或给其单独创建 App |
| Etherscan API Key | 必要时重新验证源码 | 部署员本地安全配置；普通测试组员无需获取 |
| JWT_SECRET | 后端登录令牌签名 | Render 后端 Environment；普通组员无需获取 |
| DATABASE_URL 与数据库访问权限 | 数据库访问、导出、恢复 | Render 控制台；交给负责数据库的组员 |
| Render / Alchemy / GitHub 账号权限 | 日常维护、同步、部署 | 通过平台允许的成员邀请或仓库协作者权限授予；不共享个人密码和登录令牌 |

本次没有读取这些真实值，也没有生成密钥包。密钥保管人与 Render 管理权限接手人需组内确认；公开地址不代表拥有对应钱包或账号。

**建议的私下交接顺序：** 指定维护人 → 平台邀请并验证其访问权限 → 用密码管理器的指定接收人共享等私密方式交接必要凭证 → 接收人验证地址与角色 → 记录保管责任与轮换结果。只参与网页测试的组员跳过密钥交接。

如替换 SCORER：新维护人生成专用钱包并保管私钥；Admin 在 **Roles → Scorer (credit registry)** 给新公开地址授权；更新 Render 的 `SCORER_PRIVATE_KEY` 并部署；检查 `/api/config` 显示新地址，完成一次评分上链验证；确认成功后撤销旧 SCORER 的角色。记录新公开地址即可，不提交新私钥。

## 6. 组员如何直接接手测试

### 6.1 每位测试者准备

1. 在装有 MetaMask 扩展的 Chrome 或 Edge 中打开前端。创建自己的测试钱包并自行备份，不索取他人的助记词。
2. 打开 MetaMask 的测试网络显示，选择 **Sepolia**。每个需要发交易的地址到水龙头领取少量 Sepolia ETH。
3. 网页点击 **Connect wallet**，在 MetaMask 授权正确账户；必要时点击 **Switch network**。
4. 点击 **Sign in**，签署登录消息。登录签名本身不消耗 Gas；后续领币、授权、存款等链上交易消耗 Gas。
5. 进入 **Borrow → Wallet → Get 1,000 test mUSDC**，确认链上交易，等待成功。每个钱包每小时可领取一次。
6. 切换测试钱包后，确认网页右上角地址，必要时退出再登录。建议每个角色使用独立浏览器配置，减少账户混淆。

### 6.2 Admin 为实际组员授予角色

1. 组员仅提供自己的公开 `0x...` 钱包地址。
2. 部署员用 Admin 钱包连接网站、切换 Sepolia、签名登录，进入 **Admin → Roles**。
3. 给信贷员选择 **Credit officer**，粘贴其地址，点击 **Grant**，在 MetaMask 确认交易。
4. 给审计员选择 **Auditor**，粘贴其地址，点击 **Grant** 并确认交易。
5. 等待确认及角色缓存刷新（约 30 秒）；对应组员重新登录，确认出现 **Credit officer** 或 **Audit** 页面。
6. 在下表登记公开地址和授权交易链接。借款人与信贷员必须使用不同钱包。

| 角色 | 组员 | 公开钱包地址 | 授权交易链接 | 页面确认 |
|---|---|---|---|---|
| Officer | 待登记 | 待登记 | 待登记 | 待确认 |
| Auditor | 待登记 | 待登记 | 待登记 | 待确认 |
| Borrower | 待登记 | 待登记 | 不需要角色授权 | 待确认 |
| Lender | 待登记 | 待登记 | 不需要角色授权 | 待确认 |

### 6.3 第一轮业务闭环：按顺序执行

以下是测试方案，**不是已经完成的测试结果**。每一步保存交易哈希、页面结果及必要截图。钱包弹出的代币授权 `approve` 和实际业务调用是两笔交易，需分别确认。

| 顺序 | 操作者 | 可直接执行的操作 | 预期 |
|---|---|---|---|
| 1 | Lender | 登录，Borrow 页领 1,000 mUSDC；切到 Lend，Deposit 填 `500`，点击 Deposit，依次确认授权及存款 | 出借份额出现、资金池资产增加 |
| 2 | Admin | 自己先领测试币；Admin 的储备金操作填 `50`，完成授权及 Fund reserve | reserve 增加 50 mUSDC |
| 3 | Borrower | 登录、领币；在信用问卷填入下面的合成测试向量，点击 Calculate my score | 返回分数、风险、tier |
| 4 | Borrower | 点击 Record on-chain 并确认交易 | My credit profile 显示评分、分档和有效期 |
| 5 | Borrower | Amount 填 `50`、Term 填 `30`、用途填 `Test inventory purchase`，点击 Submit application | Pending；记录贷款编号 |
| 6 | Officer | Credit officer → 找到相同贷款编号，Approve amount 填 `50`，点击 Approve 并确认 | Approved；金额不超过申请额与当前额度 |
| 7 | Borrower | 如果要求抵押，点击 Deposit collateral，依次确认授权和抵押交易 | collateral 显示已存入；高分免抵押档不会有这一步 |
| 8 | Borrower | 点击 Receive 50 mUSDC 并确认 | Active，借款本金到账，出现还款项 |
| 9 | Borrower | 点击 Repay all 填入全额，再点击 **Repay**；需要时先确认授权 | Repaid，抵押返还，按时还款历史增加 |
| 10 | Lender | Lend → Withdraw 填 `100`，点击 Withdraw 并确认 | 出借份额减少，钱包余额增加；以池内可用流动性为准 |
| 11 | Auditor | Audit → Event log，按贷款编号过滤，Export CSV；Attach an audit note 填贷款编号与测试备注，提交并确认 | 日志、CSV 和审计备注事件可对照 |

建议问卷向量来自当前 [模型测试向量](../ml/model.json)，仅用于演示，不能写成真实客户资料：

| 字段 | 中文含义 | 建议值 |
|---|---|---|
| `monthly_income_usd` | 月收入 | `280` |
| `income_volatility` | 收入波动 | `0.35` |
| `years_in_occupation` | 从业年数 | `4` |
| `mobile_money_txn_per_month` | 每月移动支付次数 | `35` |
| `mobile_money_months_active` | 使用月数 | `14` |
| `existing_debt_ratio` | 现有债务比例 | `0.25` |
| `household_size` | 家庭人数 | `4` |
| `savings_group_member` | 储蓄小组成员 | `No` / `0` |

当前模型该向量期望分数约 `594`；默认 T1 抵押率 10%，50 mUSDC 贷款对应 5 mUSDC 抵押。实际结果以运行中的模型、信用历史和链上分档配置为准；不要为凑场景偷偷改生产参数。评分过期或已使用的签名不能反复提交，失败时先检查页面和交易原因。

## 7. 后续任务清单与证据要求

| 优先级 | 任务 | 建议负责人 | 完成标准 |
|---|---|---|---|
| P0 | 确认密钥保管人与平台管理权限；处理第 9 节已知泄露风险 | 部署员 / 后端运维 | API Key 轮换与配置核对有记录，公开接口不返回凭证 |
| P0 | 给实际组员授予角色、登记钱包 | Admin | Officer / Auditor 能登录对应页面 |
| P0 | 完成第 6 节借贷闭环 | 前后端 + 测试负责人 | Pending → Approved → Active → Repaid，全链路有真实 Sepolia 证据 |
| P1 | 执行测试说明中的 S1–S10 和权限、拒绝、取消等场景 | 合约 / 测试负责人 | 逐项登记通过、失败、未执行以及原因；修复后复测 |
| P1 | 累计至少 10 种不同交易类型 | 全组 | 每种都有哈希、合约函数、操作者、结果和 Gas，不重复计数 |
| P1 | 导出审计事件、保存 Etherscan 和角色页面截图 | Auditor / 前端 | CSV、网页状态、链上记录相互对应 |
| P1 | 整理 Gas、覆盖率、Slither 和模型分析 | 合约 / 测试 / 数据负责人 | 引用已有结果，补充优化前后比较与限制；合成数据明确标注 |
| P1 | 问题分析和用户验证 | 项目负责人 / UX | 有来源的需求分析与访谈、问卷或 5–10 人可用性测试记录 |
| P1 | 跟踪 Render 数据库到期并导出数据 | 运维 | 到期日期、备份位置、恢复或迁移方案已确认 |
| P2 | 整理架构、流程、数据模型和界面图 | 各模块负责人 | 图与最终代码一致，桌面与移动端截图齐全 |
| P2 | 完成报告、幻灯片和视频 | 全组 | 团队指南建议 10–15 页报告、约 10 分钟视频，最终依正式作业要求 |
| P2 | 更新用户手册、个人贡献报告和提交清单 | 每位组员 | 个人工作与真实 commits / PRs 对应，链接可访问 |

### 7.1 可以收集的不同交易类型

| 类型 | 合约函数 | 常见执行入口 |
|---|---|---|
| 测试币领取 | MockStablecoin `faucet` | Borrow → Wallet |
| 代币授权 | MockStablecoin `approve` | 存款、抵押、还款前的钱包确认 |
| 出借存款 | LendingPool `deposit` | Lend → Deposit |
| 注入储备 | LendingPool `fundReserve` | Admin |
| 评分上链 | CreditRegistry `updateScoreWithSignature` | Borrow → Record on-chain |
| 贷款申请 | LoanManager `applyLoan` | Borrow |
| 贷款审批 | LoanManager `approveLoan` | Credit officer |
| 抵押存入 | LoanManager `depositCollateral` | Borrow，需有抵押的档位 |
| 放款 | LoanManager `disburse` | Borrow → Receive funds |
| 还款 | LoanManager `repay` | Borrow → Repay |
| 出借提现 | LendingPool `withdraw` | Lend → Withdraw |
| 审计备注 | LoanManager `addAuditNote` | Audit |
| 角色授予 | AccessControl `grantRole` | Admin → Roles，针对页面所选合约 |

不同角色重复领币、多次 `approve`、部分还款和全额还款仍分别属于同一个函数类型。登录签名、计算评分、查询数据和导出 CSV 都不是链上交易。以上是可执行计划，不代表这些交易已发生。

建议在 `docs/evidence/` 下保存去除凭证的材料，并新建测试登记表：

| 场景 / 交易类型 | 网络 | 钱包公开地址 | 贷款编号 | 交易哈希 / Etherscan 链接 | Gas Used / 实际费用 | 预期 / 实际结果 | 截图 | 日期 / 执行人 |
|---|---|---|---|---|---|---|---|---|
| 待执行 | Sepolia | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 | 待登记 |

Sepolia 不能使用 Hardhat 的时间快进。违约需真实等待到期及 7 天宽限期；可引用本地违约测试，但必须明确网络和测试方式。不要把本地 seed 数据、自动化测试或未执行的计划描述成线上交易。

## 8. 代码如何交接与发布

### 8.1 普通组员接手开发

有 Git 和 Node 22 后，在准备放项目的目录逐行执行：

```powershell
git clone https://github.com/catjlx/microlend.git
cd microlend
git switch -c feature/your-task
node --version
npm.cmd run setup
npm.cmd run build:contracts
npm.cmd test
npm.cmd --prefix backend test
npm.cmd --prefix frontend run build
```

将 `feature/your-task` 替换为自己的任务名。第一次安装需要联网。若 PowerShell 报禁止执行 `npm.ps1`，继续使用 `npm.cmd` / `npx.cmd`；若提示找不到 `git`，先安装 Git for Windows 并重开终端。只有本地模型训练或安全扫描需要额外的 Python 环境；只使用线上网页不需要这些命令。

没有团队仓库写权限的组员通过个人 Fork 提交 PR；有写权限也建议通过独立分支和 PR 合并。团队合并本次文档后，组员 `git pull` 才能在主分支获得它。新 clone 不包含 `.env`、Render 设置、MetaMask 钱包或数据库数据。

### 8.2 当前实际上线链路：不要漏掉 Fork 同步

当前顺序是：**组员代码 → catjlx/microlend 的 main → Garywong007/microlend 的 main → Render 前后端部署 → 线上复查**。

1. 小组负责人评审并合并 PR 到 `catjlx/microlend`。
2. Gary 账号负责人打开 [Gary 的仓库](https://github.com/Garywong007/microlend)，选择 `main`，点击 **Sync fork → Update branch** 同步团队仓库。
3. 如果出现冲突或 Fork 有自己的未合并提交，先比较差异并处理冲突，避免用丢弃提交的方式覆盖独有工作。
4. Render 分别打开 `microlend-api` 和 `microlend-web`，在 **Settings** 核对 Repository=`Garywong007/microlend`、Branch=`main`。检查自动部署是否开启；若未自动部署，使用 **Manual Deploy → Deploy latest commit**。
5. 等两个服务部署成功，对照 Deploy 页的 commit 与 Gary `main` 最新提交，再复查健康、配置、统计和浏览器页面。
6. 环境变量更改仍在各自 Environment 页面保存并部署；同步仓库不会传递或轮换环境变量。

本次交接文档先在 Gary 的文档分支公开并向团队仓库提交 PR；该分支提交不会直接改变 Render 当前跟踪的 `main`。

如后续改为直接跟踪团队仓库，由 Render 账号管理员取得对应 GitHub 仓库授权，再更改或重新连接两个服务的 Repository / Branch。操作前记录服务设置、环境变量与数据库绑定，操作后验证；本次没有迁移服务或更改部署来源。

## 9. 已知问题与维护注意事项

| 项目 | 当前事实 / 后续处理 |
|---|---|
| 公开健康接口可能返回私有 RPC URL | 此前 RPC 错误曾把含 Key 的 URL 带入 `/api/health` 的 `indexer.error`。当前错误为 null，但错误输出的代码风险仍在。运维需轮换该 Alchemy Key、更新 Render `RPC_URL`；后端负责人需对公开错误信息和日志做凭证脱敏。轮换和代码修复尚未确认完成 |
| 公开 RPC 配置 | 管理员核对 `PUBLIC_RPC_URL` 不含私人 Key；它通过 `/api/config` 暴露给浏览器。旧部署指南已改为使用无凭证的公开 RPC |
| 日志查询范围 | 目前依赖控制台 `INDEXER_CHUNK=10`；恢复到默认 `2000` 会重现曾遇到的 provider 限制。后续可补充 Blueprint 配置或自适应范围重试 |
| 冷启动与数据库期限 | 见下方 Render 官方说明；确认服务实例方案和数据库到期日期，不能仅凭 `render.yaml` 断言控制台当前收费状态 |
| 数据库与链上记录区别 | 链上事件可重建部分读模型，但评分问卷、登录相关数据等链下数据不能仅靠链上恢复。需要保存数据库备份与审计导出 |
| 密钥变更 | 新 SCORER 要先授角色再切配置；JWT_SECRET 更换会使旧登录令牌失效；RPC Key 轮换后检查 indexer 追赶状态 |
| 时间与利息 | 实际贷款期限、APR、抵押与到期以链上记录为准；不要为录视频声称已演示真实到期违约 |
| 测试模型 | 当前模型与投资组合模拟使用合成数据；不能据此声称真实市场信用预测效果 |
| 安全评估 | Slither 和测试结果不等于正式安全审计，报告仍需写明剩余风险 |

截至 2026-10-11，[Render 官方 Free 文档](https://render.com/docs/free)说明：Free Web Service 在 15 分钟无入站流量后休眠，唤醒约需一分钟；Free Postgres 创建 30 天后到期，随后有 14 天升级宽限期，期满删除数据。演示前提前打开网站；运维需查看真实创建日期并安排导出，不能按本文日期推算数据库到期日。

## 10. 小组负责人最终交接确认

- [ ] 本文 PR 已合并到团队仓库，所有组员知道共同入口。
- [ ] 明确当前线上源码来自 Gary 的 `main`，指定 Fork 同步和 Render 部署负责人。
- [ ] 确认 Admin、SCORER、Alchemy、Render 和数据库的保管 / 维护人。
- [ ] 私下交接必要凭证，公开文档及截图中不出现秘密值；完成已知 RPC Key 风险处理。
- [ ] 实际组员角色授予完成，借款人与信贷员为不同地址。
- [ ] 完成借贷闭环、异常测试、至少 10 种交易证据并登记真实结果。
- [ ] 报告、用户手册、幻灯片、视频、贡献报告与最终代码一致。
- [ ] 最终演示前再检查网站、健康、CORS、索引、数据库期限和部署 commit。

进一步阅读：[架构](ARCHITECTURE.md) · [测试与场景](TESTING.md) · [用户手册](USER_MANUAL.md) · [部署指南](SEPOLIA_DEPLOY.md) · [报告指南](REPORT_GUIDE.md) · [需求追踪](REQUIREMENTS_TRACEABILITY.md)。
