/**
 * 验证炉 · 插件（Host 侧，零依赖，无构建）
 *
 * 管"交付前拿什么验"：宪法执行格式、禁令句、审美验、常驻审计、算法闸。
 *
 * 选件原则（2026-10-29 主人"可以"后开炉）：
 *   只包活件，不包死件。发前拦截器写死 <workspace> 且往不存在的Smart Agent文明目录写分，
 *   故本插件不转调它；禁令扫的旧脚本一命中就往不存在的目录写档（必崩），故把它的
 *   四条规则原样搬进插件内实现，规则与依据逐条注明，可溯源。
 *
 * @module dsh-verify-kit
 */

import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'ql-verify'

export const inject = ['systemPrompt', 'tools']

const SECTION_NAME = 'ql:verify'

const DEFAULTS = Object.freeze({ order: 100, tool: true, enabled: true })

/** 禁令句四条（原样搬自 scripts/禁令执行扫描器.py，依据条款随行注明）。 */
const BAN_RULES = [
  ['回执门句式', '禁请示令(2026-10-01)', /要\s*继续\s*(就|请|才)?\s*回|请\s*回复|回复\s*[「'"]?\S{1,4}[」'"]?\s*(才|就)?\s*继续|回\s*[「'"]?(打|继续|好|是|ok|OK)[」'"]?/],
  ['请示收尾', '禁请示令(2026-10-01)', /需要的话(告诉我|说一声)|您看(呢|如何)|等你?确认|等你?点头|等主人?回复|是否需要我|要不要我(继续|做)/],
  ['待命态', '禁等任务态(2026-10-01)', /待命中|等待(任务|指令|安排)|随时(待命|听候)/],
  ['服务姿态', '禁聊天机器人令(2026-10-01)', /(竭诚|随时)?为您服务|希望(能)?帮到|祝您|还有什么(可以|能)?帮(您|你)/],
]

/** 豁免行：条款引用、判据说明、正则本身——引用不等于违令。 */
const BAN_EXEMPT = ['禁请示令', '禁聊天机器人令', '禁等任务态', '回执门句式', '病灶实锤', '机械判据', '正则', 'RULES']

function normalizeConfig(config) {
  const raw = config ?? {}
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('ql-verify: config.enabled must be a boolean')
  }
  if (raw.tool !== undefined && typeof raw.tool !== 'boolean') {
    throw new Error('ql-verify: config.tool must be a boolean')
  }
  if (raw.order !== undefined && (typeof raw.order !== 'number' || !Number.isFinite(raw.order))) {
    throw new Error('ql-verify: config.order must be a finite number')
  }
  if (raw.root !== undefined && (typeof raw.root !== 'string' || raw.root.trim() === '')) {
    throw new Error('ql-verify: config.root must be a non-empty path string')
  }
  return {
    order: raw.order ?? DEFAULTS.order,
    tool: raw.tool ?? DEFAULTS.tool,
    root: raw.root === undefined ? undefined : raw.root.trim(),
    enabled: raw.enabled ?? DEFAULTS.enabled,
  }
}

/** 工作区签名：四文件＋scripts 三件齐（同另外三枚插件，防命中 DSH 代码仓）。 */
function isWorkspace(dir) {
  try {
    return existsSync(join(dir, 'AGENTS.md'))
      && existsSync(join(dir, 'scripts'))
      && (existsSync(join(dir, 'SOUL.md')) || existsSync(join(dir, 'USER.md')))
  } catch {
    return false
  }
}

function findRoot(configured) {
  const candidates = []
  if (configured !== undefined) candidates.push(configured)
  try {
    candidates.push(dirname(dirname(fileURLToPath(import.meta.url))))
  } catch {
    /* 非文件装法 */
  }
  let dir = process.cwd()
  for (let hop = 0; hop < 6; hop += 1) {
    candidates.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  candidates.push('~//Smart Agentharness')
  for (const candidate of candidates) {
    if (isWorkspace(candidate)) return candidate
  }
  return candidates[0]
}

function runPython(root, args, timeoutMs = 60000) {
  return new Promise(resolve => {
    execFile('python3', args, {
      cwd: root,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout, stderr) => {
      resolve({
        ok: error === null,
        code: error === null ? 0 : (typeof error.code === 'number' ? error.code : 1),
        stdout: typeof stdout === 'string' ? stdout : '',
        stderr: typeof stderr === 'string' ? stderr : String(error?.message ?? ''),
      })
    })
  })
}

function clip(text, limit) {
  const flat = String(text).replace(/\s+\n/g, '\n').trim()
  return flat.length > limit ? flat.slice(0, limit) + '\n…[已截断]' : flat
}

/** 禁令扫：逐行匹配，豁免行跳过。返回命中清单。 */
function banScan(text) {
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (BAN_EXEMPT.some(word => line.includes(word))) continue
    for (const [rule, basis, pattern] of BAN_RULES) {
      const match = line.match(pattern)
      if (match !== null) {
        hits.push({ rule, basis, line: i + 1, match: match[0], context: line.trim().slice(0, 100) })
      }
    }
  }
  return hits
}

async function readJsonlRows(path) {
  try {
    const text = await readFile(path, 'utf8')
    return text.split('\n').filter(line => line.trim() !== '').map(line => {
      try { return JSON.parse(line) } catch { return { _raw: line } }
    })
  } catch {
    return []
  }
}

/** 宣称拦截：有宣称词、无实测读数 → BLOCK。 */
const CLAIM_WORDS = ['已完成', '已修好', '已上线', '已部署', '已通过', '搞定', '没问题', '应该可以', '肯定', '必然', '全绿', '全部通过', '应该没问题']
const MEASURE = /\d|复现|命令|实测|读数|exit\s*\d|KB|MB|字节|%/i
const ABSOLUTE = /100%|永不|绝对|零缺陷/

function claimGate(text) {
  const hits = CLAIM_WORDS.filter(word => text.includes(word))
  const measured = MEASURE.test(text)
  const absolute = ABSOLUTE.test(text)
  const verdict = hits.length > 0 && !measured ? '拦截' : (absolute && !measured ? '黄标' : 'PASS')
  const lines = [
    `过闸判定：${verdict}`,
    `宣称词：${hits.length > 0 ? hits.join('、') : '无'}`,
    `实测支撑：${measured ? '有（数字/复现/读数）' : '无'}`,
    absolute ? '绝对词：命中（100%/永不/绝对/零缺陷）——须有对照或穷尽记录' : '绝对词：无',
  ]
  if (verdict !== 'PASS') {
    lines.push('', '改法：给出值／出处／时点／复验命令四件，或把话降级为"估算/未知"。')
  }
  return lines.join('\n')
}

/** 发前拦截：出厂三检（安全／机密／体量）。 */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥块'],
  [/\b(sk-[A-Za-z0-9]{12,}|AKID[A-Za-z0-9]{10,})\b/, '疑似云密钥'],
  [/(secret|token|password|passwd|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i, '明文密钥赋值'],
  [/\b\d{17}[\dXx]\b/, '疑似身份证号'],
]
const FORBIDDEN_NAMES = ['.env', 'id_rsa', '凭据', 'secret', 'credentials']

async function preSendGate(root, target) {
  const path = target.startsWith('/') ? target : join(root, target)
  const lines = ['【发前拦截·三检】']
  let blocked = false
  try {
    const info = await stat(path)
    lines.push(`①存在：✅ ${(info.size / 1024).toFixed(1)} KB`)
    if (info.size === 0) { blocked = true; lines.push('   空文件＝0 分打回') }
  } catch {
    return '【发前拦截】❌ 目标不存在：' + target
  }
  const base = path.split('/').pop() ?? ''
  const named = FORBIDDEN_NAMES.find(word => base.toLowerCase().includes(word.toLowerCase()))
  if (named !== undefined) { blocked = true; lines.push(`②机密：❌ 文件名含禁传标记「${named}」`) }
  else lines.push('②机密：文件名无禁传标记')
  let text = ''
  try {
    text = await readFile(path, 'utf8')
  } catch {
    text = ''
  }
  const secretHit = SECRET_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
  if (secretHit.length > 0) { blocked = true; lines.push(`   内容命中：${secretHit.join('、')}`) }
  else if (text !== '') lines.push('   内容：无密钥/证件号指纹')
  lines.push(`③体量：${(await stat(path)).size > 50 * 1024 * 1024 ? '⚠ 超 50MB，上载前分包' : '常规'}`)
  lines.push('', blocked ? '判定：BLOCK（禁发）' : '判定：PASS（可发）')
  return lines.join('\n')
}

function renderSection() {
  return [
    '## 验证炉令 · 常驻（交付前先问"哪条机械件验过它"）',
    '',
    '**没有验证支撑的宣称＝标签泄漏嫌疑，禁出口**。验证不是态度，是闸。',
    '',
    '**一、交付前五阶（判据顺序不可倒）**',
    '①自检（对错）→②挑剔（好坏）→③嫌弃（该不该出手）→④判垃圾（方向对不对）→⑤完美主义（够不够精品）。'
      + '五阶全过才叫值得交；前三阶任一不过，后面的打磨全是浪费。',
    '',
    '**二、机械闸（能脚本判的绝不靠感觉）**',
    '· 算法闸：脚本类产物出厂前过算法层体检器（笨算法命中=黄标打回）；',
    '· 禁令闸：对主人出口前扫违令句式（请示回执／待命态／服务姿态四类）；',
    '· 审美闸：产物交付前跑审美验与品味四问（功能达标但丑＝打回）；',
    '· 常驻审计：跑常驻进程审计，看谁在跑、谁该跑没跑、谁野着；',
    '· 宪法执行格式：定期扫四文件——写了"必须怎么干"的条款，有没有机械件接住；',
    '· 宣称闸：有宣称词而无实测读数＝拦截；发前拦截：三检（存在/机密/体量）不过＝禁发。',
    '',
    '**三、读数三层，禁混用**',
    '实测（有复现命令）＞估算（标明估算口径）＞未知（只说不知道+下一步取证）。'
      + '把估算说成实测＝造假；把未知说成经验＝吹牛。',
    '',
    '**四、事故即检查项**',
    '每次出事，除复盘外必须产出至少一个可机械判的检查项——只留教训不留检查项＝学费白交。',
    '',
    '**判据**：交出去之前自问一句"这东西被哪条闸验过、读数是多少"——答不出＝没验，不许说"应该没问题"。',
  ].join('\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  if (!cfg.enabled) {
    ctx.logger?.info?.('ql-verify：主开关关着，未挂载')
    return
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: cfg.order,
    text: () => renderSection(),
  }), 'ql-verify.section()')

  if (cfg.tool) {
    ctx.effect(() => ctx.tools.register({
      name: 'ql_verify',
      description: '验证炉闸：宪法执行格式扫描（四文件执行条款 vs 机械件覆盖）、禁令句扫（四类违令句式·插件内实现）、'
        + '审美验（十八条落刀验）、常驻进程审计（谁在跑/该跑没跑/野进程）、算法闸（单脚本笨算法体检）。'
        + '只读或只做本地判定，不写台账。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['宪法执行格式', '禁令扫', '审美验', '常驻审计', '算法闸', '宣称拦截', '发前拦截'],
            description: '要跑的闸。',
          },
          query: {
            type: 'string',
            description: '禁令扫＝待检文本；算法闸＝待检脚本路径（相对工作区）；其余动作忽略。',
          },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: { report: { type: 'string' } },
          required: ['report'],
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: value.report }],
      },
      execute: async (args) => {
        const root = findRoot(cfg.root)
        const action = typeof args?.action === 'string' ? args.action : '宪法执行格式'
        const query = typeof args?.query === 'string' ? args.query.trim() : ''
        try {
          if (action === '宪法执行格式') {
            const result = await runPython(root, ['scripts/Agent执行格式扫描器.py'], 30000)
            const body = `${result.stdout}${result.stderr}`.trim()
            return { report: body === '' ? `（无输出·exit ${result.code}）` : clip(body, 4000) }
          }

          if (action === '禁令扫') {
            if (query === '') return { report: '禁令扫需要 query（要检查的文本）。' }
            const hits = banScan(query)
            if (hits.length === 0) return { report: '✅ 静默通过：零违令句式（四类规则全扫过）' }
            const lines = [`❌ 违令命中 ${hits.length} 处：`]
            for (const hit of hits.slice(0, 20)) {
              lines.push(`  [${hit.rule}] 第${hit.line}行 →「${hit.match}」｜依据：${hit.basis}`)
              lines.push(`     语境：${hit.context}`)
            }
            return { report: lines.join('\n') }
          }

          if (action === '审美验') {
            const result = await runPython(root, ['scripts/审美扫描器.py', '--验活'], 30000)
            const body = `${result.stdout}${result.stderr}`.trim()
            return { report: body === '' ? `（无输出·exit ${result.code}）` : clip(body, 3000) }
          }

          if (action === '常驻审计') {
            const result = await runPython(root, ['scripts/常驻进程审计器.py', '--json'], 90000)
            if (!result.ok) return { report: `常驻审计跑挂（exit ${result.code}）：${clip(result.stderr, 400)}` }
            let parsed
            try {
              parsed = JSON.parse(result.stdout)
            } catch {
              return { report: clip(result.stdout, 3000) }
            }
            const scan = parsed['扫描'] ?? {}
            const procs = Array.isArray(parsed['运行进程']) ? parsed['运行进程'] : []
            const groups = new Map()
            for (const proc of procs) {
              const key = proc['性质'] ?? proc['判定'] ?? '未标性质'
              groups.set(key, (groups.get(key) ?? 0) + 1)
            }
            const lines = [
              '【常驻审计】',
              `扫描：现役脚本 ${scan['现役脚本'] ?? '?'} · 档案跳过 ${scan['档案跳过'] ?? '?'} · 第三方跳过 ${scan['第三方跳过'] ?? '?'}`,
              `运行进程：${procs.length} 个（耗时 ${parsed['耗时秒'] ?? '?'} 秒）`,
            ]
            for (const [key, count] of [...groups.entries()].sort((a, b) => b[1] - a[1])) {
              lines.push(`  ${key}：${count}`)
            }
            const longest = [...procs].sort((a, b) => (b['已运行小时'] ?? 0) - (a['已运行小时'] ?? 0)).slice(0, 3)
            if (longest.length > 0) {
              lines.push('', '跑得最久三件：')
              for (const proc of longest) {
                lines.push(`  · ${proc['脚本名'] ?? '?'}（${proc['已运行小时'] ?? '?'} 小时·${proc['性质'] ?? '?'}）`)
              }
            }
            if (procs.length === 0) lines.push('  （读不到进程表，可能权限受限）')
            return { report: lines.join('\n') }
          }

          if (action === '宣称拦截') {
            if (query === '') return { report: '宣称拦截需要 query（待检文本）。' }
            return { report: claimGate(query) }
          }

          if (action === '发前拦截') {
            if (query === '') return { report: '发前拦截需要 query（待发文件路径）。' }
            return { report: await preSendGate(root, query) }
          }

          if (action === '算法闸') {
            if (query === '') return { report: '算法闸需要 query（脚本路径）。' }
            const result = await runPython(root, ['scripts/算法层体检器.py', '--查', query], 30000)
            const body = `${result.stdout}${result.stderr}`.trim()
            return { report: body === '' ? `（无输出·exit ${result.code}）` : clip(body, 2500) }
          }

          return { report: `未知动作：${action}` }
        } catch (error) {
          return { report: `验证炉内部错：${clip(error?.message ?? error, 200)}` }
        }
      },
    }), 'ql-verify.tool()')
  }

  ctx.logger?.info?.('ql-verify：区块 %s 已注册（order=%d）', SECTION_NAME, cfg.order)
}
