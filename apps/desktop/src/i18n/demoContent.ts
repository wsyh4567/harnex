import type {
  ApprovalRequest,
  ChatMessage,
  EvolutionProposal,
  EvolutionStage,
  GenomeCommit,
  GuardianDecision,
  OnboardingReplayTrace,
  Thread,
} from "@harnex/protocol";
import type { Locale } from "./types.ts";

export interface EvolutionBlueprint {
  id: string;
  domain: string;
  title: string;
  subtitle: string;
  inspirations: string[];
  starterReply: string;
}

const isZh = (locale: Locale): boolean => locale.startsWith("zh");

export function localizeThreadTitle(thread: Thread, locale: Locale): string {
  if (!isZh(locale)) return thread.title;
  const map: Record<string, string> = {
    "thr-billing-csv": "账单 CSV 编码修复",
    "thr-competitor-dossier": "竞品简报对比汇总",
    "thr-acme-logs": "日志 502 超时异常排查",
    "New Command Thread": "新建任务",
    "New Task": "新建任务",
  };
  if (map[thread.id]) return map[thread.id]!;
  if (map[thread.title]) return map[thread.title]!;
  return thread.title;
}

export function localizeGoalTitle(goalId: string, fallback: string, locale: Locale): string {
  if (!isZh(locale)) return fallback;
  const map: Record<string, string> = {
    g1: "扫描 ~/Work/invoices 目录",
    g2: "安全识别并解码 GB18030/GBK 表头",
    g3: "导出规范化 UTF-8 汇总表",
    g4: "收集本地产品简报笔记",
    g5: "起草竞品对比矩阵",
    g6: "定位 nginx 502 异常时间窗",
    g7: "汇总上游超时根因",
    "g-step-1": "检查工作区输入文件",
    "g-step-2": "在沙盒内执行转换处理",
    "g-step-3": "校验输出并生成摘要",
  };
  return map[goalId] ?? fallback;
}

export function localizeThreadStatus(status: Thread["status"], locale: Locale): string {
  if (isZh(locale)) {
    const map: Record<Thread["status"], string> = {
      idle: "待命",
      running: "运行中",
      paused: "已暂停",
      awaiting_approval: "待确认授权",
      completed: "已完成",
      failed: "失败",
      aborted: "已中止",
    };
    return map[status];
  }
  const map: Record<Thread["status"], string> = {
    idle: "Idle",
    running: "Running",
    paused: "Paused",
    awaiting_approval: "Awaiting Approval",
    completed: "Completed",
    failed: "Failed",
    aborted: "Aborted",
  };
  return map[status];
}

export function localizeDomainLabel(domain: string, locale: Locale): string {
  if (isZh(locale)) {
    const map: Record<string, string> = {
      file_ops: "文件处理",
      research: "调研分析",
      diagnostics: "故障排查",
      general: "通用任务",
      seed: "出厂种子",
      memory: "记忆分层",
      hooks: "安全 Hooks",
      skills: "技能引擎",
      sub_agents: "多代理协作",
      mcp: "MCP 工具链",
      sandbox_views: "沙盒与动态视图",
      migration: "版本迁移",
      csv_ops: "表格处理",
    };
    return map[domain] ?? domain;
  }
  const map: Record<string, string> = {
    file_ops: "File Ops",
    research: "Research",
    diagnostics: "Diagnostics",
    general: "General",
    seed: "Factory Seed",
    memory: "Memory",
    hooks: "Hooks",
    skills: "Skills",
    sub_agents: "Multi-Subagent",
    mcp: "MCP Ops",
    sandbox_views: "Sandbox & Views",
    migration: "Migration",
    csv_ops: "CSV Ops",
  };
  return map[domain] ?? domain;
}

export function localizeMessage(
  msg: ChatMessage,
  locale: Locale,
): {
  content: string;
  reasoning?: string;
  toolOutputs: Record<string, string>;
} {
  if (!isZh(locale)) {
    const toolOutputs: Record<string, string> = {};
    for (const tc of msg.toolCalls ?? []) {
      if (tc.output) toolOutputs[tc.id] = tc.output;
    }
    return { content: msg.content, reasoning: msg.reasoning, toolOutputs };
  }

  const contentMap: Record<string, string> = {
    "msg-1": "解析 ~/Work/invoices 中本月乱码的账单 CSV 文件，并生成 report_utf8.csv。",
    "msg-2":
      "已扫描 ~/Work/invoices 下的 12 个 CSV 文件。检测到历史 GBK / GB18030 字节序列导致 UTF-8 解码在第 4–19 行失败。",
    "msg-3": "禁止使用有损 UTF-8 强制解码。请先探测 GB18030 编码，并完整保留人民币金额小数精度后再导出。",
    "msg-4": "已应用人工纠偏指令，并自动标记送入 Harness² 自进化队列。当前正尝试将汇总结果写入工作区之外的路径。",
    "msg-c1": "对比 ~/Work/briefs 中的本地产品规格文档，整理一份功能对比表。",
    "msg-c2": "当前处于规划模式。已收集 4 份本地 Markdown 简报，发送下一步指令或切换到执行模式即可写出对比矩阵。",
    "msg-a1": "汇总 access.log 中 UTC 02:15 前后的上游超时高峰原因。",
    "msg-a2": "UTC 02:14:10 至 02:16:40 期间 502 报错率峰值达到 14.8%，根因是上游工作进程池打满（128/128 全部繁忙）。",
  };

  const reasoningMap: Record<string, string> = {
    "msg-2":
      "1. 通过 fs_scan 列出目录文件。\n2. 首次 UTF-8 读取出现 U+FFFD 替换乱码。\n3. 探测文件 BOM 并切换 TextDecoder('gb18030') 进行无损解码。",
  };

  const toolOutputMap: Record<string, string> = {
    "tc-1": "发现 12 个文件（共 482 KB）。表头字节示例：b9 a9 d3 a6 c9 cc...",
    "tc-2": "text/plain; charset=unknown-8bit（检测到 GB18030 字节特征）",
  };

  const toolOutputs: Record<string, string> = {};
  for (const tc of msg.toolCalls ?? []) {
    if (tc.output) {
      toolOutputs[tc.id] = toolOutputMap[tc.id] ?? tc.output;
    }
  }

  return {
    content: contentMap[msg.id] ?? msg.content,
    reasoning: msg.reasoning ? (reasoningMap[msg.id] ?? msg.reasoning) : undefined,
    toolOutputs,
  };
}

export function localizeApproval(
  req: ApprovalRequest,
  locale: Locale,
): { summary: string; detail: string; riskLabel: string } {
  if (!isZh(locale)) {
    const riskMap = { low: "Low", medium: "Medium", high: "High", critical: "Critical" } as const;
    return {
      summary: req.summary,
      detail: req.detail,
      riskLabel: riskMap[req.riskLevel],
    };
  }
  const riskMap = { low: "低风险", medium: "中风险", high: "高风险", critical: "严重风险" } as const;
  const map: Record<string, { summary: string; detail: string }> = {
    "apr-l0-export": {
      summary: "尝试写入工作区之外的路径：~/Desktop/quarterly_report.csv",
      detail:
        "Rust L0 操作系统沙盒拦截了指向 ~/Work 边界之外的写入操作。选择「仅本次允许」将只放行这一次文件写入，其余路径仍受工作区写隔离墙保护。",
    },
    "apr-hook-sha": {
      summary: "Hook SHA-256 首次信任确认：hooks/csv_utf8_guard.ts",
      detail:
        "检测到脚本内容哈希发生变化或为新进化生成的 Hook，尚未记录在 ~/.harnex/trust.json 中。请确认代码安全后再启用。",
    },
  };
  const localized = map[req.requestId];
  return {
    summary: localized?.summary ?? req.summary,
    detail: localized?.detail ?? req.detail,
    riskLabel: riskMap[req.riskLevel],
  };
}

export function localizeGuardianDecision(gd: GuardianDecision, locale: Locale): string {
  if (!isZh(locale)) return gd.reason;
  const map: Record<string, string> = {
    "grd-101": "在绑定工作区 ~/Work 内执行只读文件特征探测，自动放行。",
    "grd-102": "当前任务曾接触外部网页内容；出站请求或高权限脚本需要人工二次确认。",
  };
  return map[gd.requestId] ?? gd.reason;
}

export function localizeProposal(
  p: EvolutionProposal,
  locale: Locale,
): {
  title: string;
  whatChangedSummary: string;
  statusLabel: string;
  triggerLabel: string;
  winnerLabel: string;
  optionALabel: string;
  optionBLabel: string;
  confidenceLabel: string;
  judgeReasoning: string;
  cue: string;
  lesson: string;
  evidence: string;
} {
  const statusMapEn: Record<EvolutionProposal["status"], string> = {
    running: "Running",
    ready: "Ready",
    adopted: "Adopted",
    rejected: "Rejected",
    needs_reprobe: "Needs Re-Probe",
    archived_no_entry: "Archived",
  };
  const statusMapZh: Record<EvolutionProposal["status"], string> = {
    running: "评测中",
    ready: "待审阅",
    adopted: "已采纳",
    rejected: "已拒绝",
    needs_reprobe: "需重测",
    archived_no_entry: "已归档",
  };

  if (!isZh(locale)) {
    const bj = p.blindJudge;
    return {
      title: p.title,
      whatChangedSummary:
        p.experienceEntry?.editsSummary ??
        p.diffs.map((d) => `${d.changeType}: ${d.path}`).join("; "),
      statusLabel: statusMapEn[p.status],
      triggerLabel: p.triggerSource,
      winnerLabel: bj?.winnerLabel ?? "",
      optionALabel: bj?.optionALabel ?? "",
      optionBLabel: bj?.optionBLabel ?? "",
      confidenceLabel: bj?.confidence ?? "medium",
      judgeReasoning: bj?.reasoning ?? "",
      cue: p.experienceEntry?.cue ?? "",
      lesson: p.experienceEntry?.lesson ?? "",
      evidence: p.experienceEntry?.evidence ?? "",
    };
  }

  const triggerMapZh: Record<string, string> = {
    steer: "人工纠偏触发",
    manual: "手动触发",
    auto: "自动触发",
    inline_revision: "行内批注修订",
    upgrade_migration: "版本升级迁移",
  };
  const confMapZh: Record<string, string> = {
    high: "高",
    medium: "中",
    low: "低",
  };

  if (p.id === "prop-8") {
    return {
      title: "提案 #8：自动识别 GB18030/GBK 编码 CSV 并安全去除 BOM",
      whatChangedSummary:
        "新增安全编码探测脚本 scripts/safe_gbk_parse.ts，并在 Shell 工具说明中补充中文历史表格探测提示。",
      statusLabel: statusMapZh[p.status],
      triggerLabel: triggerMapZh[p.triggerSource] ?? p.triggerSource,
      winnerLabel: "候选方案 B（进化版）",
      optionALabel: "基线版本 v7",
      optionBLabel: "候选版本 v8（GBK 解析器 + Shell 提示）",
      confidenceLabel: "高",
      judgeReasoning:
        "候选方案通过 TextDecoder('gb18030', { fatal: true }) 在 2 步内稳定识别 GB18030 字节范围，实现 0 解码错误，同时完整保留人民币小数精度，避免了有损 UTF-8 乱码。",
      cue: "CSV 或表格文件包含 U+FFFD 替换乱码或历史中文编码字节序列",
      lesson: "先使用 strict 模式（fatal: true）尝试 UTF-8 解码，失败后再通过 scripts/safe_gbk_parse.ts 回退至 gb18030 解析。",
      evidence: "在 CoW 影子沙盒针对 12 份发票 CSV 样例实测：执行步数从 7 步降至 2 步，报错从 3 次降至 0 次。",
    };
  }

  if (p.id === "prop-9") {
    return {
      title: "提案 #9：从外部简报中提取并统一产品定价对比矩阵",
      whatChangedSummary:
        "新增技能 skills/dossier_matrix/SKILL.md，并在系统提示词中增加价格维度归一化引用指引。",
      statusLabel: statusMapZh[p.status],
      triggerLabel: triggerMapZh[p.triggerSource] ?? p.triggerSource,
      winnerLabel: "候选方案 A（进化版）",
      optionALabel: "候选版本（含网页调研技能）",
      optionBLabel: "基线版本 v7",
      confidenceLabel: "中",
      judgeReasoning:
        "候选方案新增了可复用的表格归一化技能 skills/dossier_matrix/SKILL.md。由于任务轨迹包含外部网页输入，采纳前需由人工核验来源安全。",
      cue: "需要综合本地文档与外部网页简报生成多厂商定价对比表时",
      lesson: "生成对比矩阵前先将所有计费周期统一换算为美元/月，再进行横向比对。",
      evidence: "影子沙盒实测消除了 1 次币种错配告警，并将步骤从 6 步缩短至 3 步。",
    };
  }

  const bj = p.blindJudge;
  return {
    title: p.title,
    whatChangedSummary:
      p.experienceEntry?.editsSummary ??
      p.diffs.map((d) => `${d.path} (${d.changeType})`).join("、"),
    statusLabel: statusMapZh[p.status],
    triggerLabel: triggerMapZh[p.triggerSource] ?? p.triggerSource,
    winnerLabel: bj?.winnerIsCandidate ? "候选方案（进化版）" : "基线方案",
    optionALabel: bj?.optionALabel ?? "方案 A",
    optionBLabel: bj?.optionBLabel ?? "方案 B",
    confidenceLabel: confMapZh[bj?.confidence ?? "medium"] ?? (bj?.confidence ?? "中"),
    judgeReasoning: bj?.reasoning ?? "",
    cue: p.experienceEntry?.cue ?? "",
    lesson: p.experienceEntry?.lesson ?? "",
    evidence: p.experienceEntry?.evidence ?? "",
  };
}

export function localizeCommitMessage(commit: GenomeCommit, locale: Locale): string {
  if (!isZh(locale)) return commit.message;
  const map: Record<string, string> = {
    v7: "采纳文件批处理目录扫描经验与回归防线",
    v6: "将上游超时排查经验沉淀至 diagnostics/EXPERIENCE.md",
    v5: "新增严格 JSON 输出结构防线",
    v0: "Harnex 出厂极简种子（纯净初始状态）",
  };
  return map[commit.versionTag] ?? commit.message;
}

export function localizeComponentTag(comp: string, locale: Locale): string {
  if (!isZh(locale)) return comp;
  const map: Record<string, string> = {
    tool_descriptions: "工具说明",
    meta: "元数据",
    memory: "长期记忆",
    guardrails: "行为护栏",
    skills: "技能库",
    systemprompt: "系统提示词",
    scripts: "脚本工具",
    hooks: "钩子",
    mcp: "MCP",
    sub_agents: "子代理",
  };
  return map[comp] ?? comp;
}

export function localizeSourceTags(tags: string[], locale: Locale): string {
  if (!isZh(locale)) return tags.join(", ");
  const map: Record<string, string> = {
    web: "网页",
    external_file: "外部文件",
    untrusted_mcp: "外部 MCP",
    local: "本地",
  };
  return tags.map((tag) => map[tag] ?? tag).join("、");
}

export function localizeStageLabel(stage: EvolutionStage, locale: Locale): string {
  if (isZh(locale)) {
    const map: Record<EvolutionStage, string> = {
      queued: "排队",
      proposing_inv: "通用轨",
      proposing_dom: "领域轨",
      shadow_probing: "影子沙盒",
      composing: "方案合成",
      blind_judging: "双盲裁判",
      regression_checking: "回归测试",
      reflecting: "经验沉淀",
      completed: "就绪",
      failed: "失败",
    };
    return map[stage];
  }
  const map: Record<EvolutionStage, string> = {
    queued: "Queued",
    proposing_inv: "Invariant Track",
    proposing_dom: "Domain Track",
    shadow_probing: "Shadow Sandbox",
    composing: "Composing",
    blind_judging: "Blind Judge",
    regression_checking: "Regression",
    reflecting: "Experience",
    completed: "Ready",
    failed: "Failed",
  };
  return map[stage];
}

export function localizeOnboardingReplay(
  replay: OnboardingReplayTrace,
  locale: Locale,
): {
  title: string;
  disclaimer: string;
  steps: Array<{ stage: string; title: string; detail: string; offsetMs: number }>;
} {
  if (!isZh(locale)) {
    return {
      title: replay.title,
      disclaimer: replay.disclaimer,
      steps: replay.steps,
    };
  }
  return {
    title: "首启试炼：从 v0 编码报错到 v1 自主修复",
    disclaimer: "真实录制回放样本：无需配置 API 密钥，即可直观看到 Harnex 如何从单次失败中进化。",
    steps: replay.steps.map((s, idx) => {
      const zhTitles = [
        "v0 基线尝试（UTF-8 读取乱码报错）",
        "捕获执行失败轨迹并送入双轨评估",
        "通用轨提炼编码边界不变量",
        "领域轨生成 safe_gbk_parse.ts 脚本与提示",
        "CoW 影子沙盒隔离复现验证",
        "双盲 A/B 裁判交叉一致性检验",
        "全量历史回归测试集校验",
        "经验沉淀写入 EXPERIENCE.md 并准备就绪",
      ];
      const zhDetails = [
        "v0 纯净种子直接使用默认 UTF-8 读取 GBK 账单文件，产生 U+FFFD 乱码并触发 3 次解析异常。",
        "Harness² 将失败轨迹与上下文快照锁定，进入独立后台进化流水线。",
        "提炼通用原则：严禁对未知字节流做有损替换解码，必须先做严格模式探测。",
        "生成沙盒单文件助手 scripts/safe_gbk_parse.ts，并更新 Shell 工具说明。",
        "在 Copy-on-Write 影子沙盒内重跑 12 份发票 CSV：步数由 7 步降至 2 步，报错归零。",
        "双盲裁判在匿名洗牌正反两次评测中一致判定进化方案 v1 胜出。",
        "确认新增规则未破坏原有 6 项回归测试基准（6/6 全部通过）。",
        "将「触发场景 / 处理方法 / 实证依据」写入 EXPERIENCE.md，等待人工审阅采纳。",
      ];
      return {
        ...s,
        title: zhTitles[idx] ?? s.title,
        detail: zhDetails[idx] ?? s.detail,
      };
    }),
  };
}

export function getEvolutionBlueprints(locale: Locale): EvolutionBlueprint[] {
  if (isZh(locale)) {
    return [
      {
        id: "memory",
        domain: "memory",
        title: "1. 记忆系统",
        subtitle: "沉淀偏好与跨任务经验，越用越懂你",
        inspirations: [
          "分层记忆结构",
          "个人偏好沉淀",
          "跨任务语义检索",
          "自动清理过时记忆",
        ],
        starterReply:
          "你想让 Harnex 记住哪类信息？比如你的输出风格偏好、项目约定，还是历史踩坑经验？我们可以聊聊怎样记录最自然、什么时候该忘记。",
      },
      {
        id: "skills",
        domain: "skills",
        title: "2. 技能库",
        subtitle: "把高频流程沉淀成可复用、可持续优化的技能",
        inspirations: [
          "高频流程自动提炼",
          "相似技能去重合并",
          "触发条件优化",
          "跨项目技能复用",
        ],
        starterReply:
          "最近有没有哪些重复做过好几次的任务流程，让你觉得每次都要重新解释很烦？说说看，我们可以把它沉淀成一套随时可调用的技能。",
      },
      {
        id: "mcp",
        domain: "mcp",
        title: "3. 工具与连接 (MCP)",
        subtitle: "打通本地软件、浏览器与外部工作流",
        inspirations: [
          "本地办公套件模板",
          "浏览器自动化流",
          "断线自动重连诊断",
          "统一工具目录管理",
        ],
        starterReply:
          "你平时最常把哪些本地工具、文档软件或网页操作串在一起？我们可以一起规划最顺手的连接方式与异常自愈策略。",
      },
      {
        id: "hooks",
        domain: "hooks",
        title: "4. 流程钩子 (Hooks)",
        subtitle: "在执行前后自动校验、纠错、格式化与守卫",
        inspirations: [
          "敏感信息自动脱敏",
          "危险操作前拦截",
          "代码与输出自动格式化",
          "可复用测试守卫模板",
        ],
        starterReply:
          "你希望在任务执行的哪个环节加上自动把关？比如输出前自动检查格式、脱敏密钥，还是执行命令前做一次二次校验？",
      },
      {
        id: "sub_agents",
        domain: "sub_agents",
        title: "5. 多代理协作",
        subtitle: "拆解复杂任务，让多个专职角色分工配合",
        inspirations: [
          "调研与校验双角色协作",
          "大任务自动拆解调度",
          "只读审核子代理模板",
          "并行汇总与冲突检查",
        ],
        starterReply:
          "当遇到比较庞杂的任务时，你更希望怎么分工？例如一个负责搜集和起草，另一个专门挑刺和核对？聊聊你理想中的协作节奏。",
      },
      {
        id: "sandbox_views",
        domain: "sandbox_views",
        title: "6. 安全边界与交互视图",
        subtitle: "强化沙盒执行边界，长出更直观的动态视图",
        inspirations: [
          "表格与报告动态预览卡",
          "按场景收紧沙盒策略",
          "零副作用模拟演练",
          "执行轨迹可视化视图",
        ],
        starterReply:
          "除了纯文本结果，你希望哪些数据或任务能直接长出直观的卡片视图？或者在安全权限上希望增加哪些按场景收紧的保护？",
      },
      {
        id: "custom",
        domain: "general",
        title: "7. 自定义进化方向",
        subtitle: "自由描述任何你想让 Harnex 长出的新能力",
        inspirations: [
          "解决近期高频卡壳点",
          "定制团队专属工作流",
          "改进输出结构与规范",
          "减少某类任务人工纠偏",
        ],
        starterReply:
          "不局限于上面的分类——直接说说你最近用起来觉得哪里不够顺手，或者最想让 Harnex 学会什么新本领？",
      },
    ];
  }

  return [
    {
      id: "memory",
      domain: "memory",
      title: "1. Memory System",
      subtitle: "Retain preferences and cross-task lessons over time",
      inspirations: [
        "Layered memory tiers",
        "Preference retention",
        "Cross-task semantic recall",
        "Stale memory pruning",
      ],
      starterReply:
        "What kinds of context do you wish Harnex remembered across sessions—formatting preferences, project conventions, or past pitfalls? Let's shape how it remembers and when it should forget.",
    },
    {
      id: "skills",
      domain: "skills",
      title: "2. Skills Library",
      subtitle: "Turn recurring workflows into reusable, evolving skills",
      inspirations: [
        "Extract recurring workflows",
        "Merge overlapping skills",
        "Sharpen trigger matching",
        "Cross-project skill reuse",
      ],
      starterReply:
        "Are there repetitive multi-step tasks you keep re-explaining? Tell me about the workflow and we can distill it into a reusable skill.",
    },
    {
      id: "mcp",
      domain: "mcp",
      title: "3. Tools & MCP",
      subtitle: "Connect local apps, browsers, and external workflows",
      inspirations: [
        "Local office app bundles",
        "Browser workflow templates",
        "Reconnect & health checks",
        "Visual tool catalog",
      ],
      starterReply:
        "Which local apps, spreadsheets, or browser workflows do you reach for most often? Let's design cleaner integrations and resilient fallback handling.",
    },
    {
      id: "hooks",
      domain: "hooks",
      title: "4. Workflow Hooks",
      subtitle: "Automate guards, checks, and formatting around tool runs",
      inspirations: [
        "Auto PII & secret redaction",
        "Pre-execution safety guards",
        "Output & code formatting",
        "Reusable verification hooks",
      ],
      starterReply:
        "Where in a task loop would an automatic checkpoint help most—redacting sensitive output, validating files, or formatting results before completion?",
    },
    {
      id: "sub_agents",
      domain: "sub_agents",
      title: "5. Multi-Agent Collaboration",
      subtitle: "Split complex goals across specialized parallel workers",
      inspirations: [
        "Researcher + verifier pair",
        "Parallel task decomposition",
        "Read-only review workers",
        "Result synthesis & checks",
      ],
      starterReply:
        "For larger goals, how would you like specialist agents to divide the work—for instance, one drafting while another independently verifies?",
    },
    {
      id: "sandbox_views",
      domain: "sandbox_views",
      title: "6. Sandbox & Views",
      subtitle: "Harden execution boundaries and grow richer interactive views",
      inspirations: [
        "Interactive table & report cards",
        "Scenario-specific policy packs",
        "Zero-side-effect dry runs",
        "Execution trace visualizers",
      ],
      starterReply:
        "Beyond plain text replies, which results would benefit from a custom preview card—or what stricter sandbox boundaries would give you more confidence?",
    },
    {
      id: "custom",
      domain: "general",
      title: "7. Custom Evolution Direction",
      subtitle: "Freely describe any capability you want Harnex to grow",
      inspirations: [
        "Fix a recurring friction point",
        "Build a custom workflow",
        "Standardize output formats",
        "Reduce manual steering",
      ],
      starterReply:
        "Feel free to think outside the categories above—what friction point annoyed you recently, or what new capability would make Harnex noticeably smarter for you?",
    },
  ];
}

export function generateGuidedAssistantReply(
  blueprint: EvolutionBlueprint,
  userMessage: string,
  goalText: string,
  locale: Locale,
): string {
  const snippet = userMessage.trim().slice(0, 80);
  const hasGoal = goalText.trim().length > 0;
  if (isZh(locale)) {
    return [
      `明白，你的核心诉求是围绕「${blueprint.title}」解决「${snippet}」。`,
      `建议本次进化重点关注两个判断标准：一是真实场景下能明显减少人工反复说明；二是在影子沙盒验证时不破坏现有任务稳定性。`,
      hasGoal
        ? `你可以继续补充细节，或直接点击下方「启动本次进化评测」开始验证。`
        : `如果方向合适，可以点击「将讨论总结填入目标」快速整理到下方目标框，再启动进化评测。`,
    ].join("\n\n");
  }
  return [
    `Got it — for "${blueprint.title}", we'll focus on "${snippet}".`,
    `Two helpful ways to judge success here: noticeably less manual steering on real tasks, and zero regressions inside the Shadow Sandbox.`,
    hasGoal
      ? `Feel free to refine further, or click "Run Evolution Cycle" whenever you're ready.`
      : `When this direction feels right, click "Apply Discussion to Goal" to draft it below and launch an evaluation.`,
  ].join("\n\n");
}
