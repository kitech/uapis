import { ErrorCode, fail } from '../core/errors'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { TransformResult, UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * PyPI JSON API，零 key：<https://warehouse.pypa.io/api-reference/json.html>
 *
 * `/pypi/{name}/json` 是个雷：requests 193KB、numpy 1.6MB，96% 的体积都在
 * `releases`（全部历史版本 × 每个文件的清单），而本项目上游硬上限 512KB
 * （超过就是 413 FILE_TOO_LARGE）。所以项目档做 transform：
 * 丢掉 `releases` 只留版本号数组，`info` 里也丢掉 README 全文（`description`）。
 * requests 这样从 193KB 降到 ~7KB，numpy 也不会再撞上限。
 */
const API = 'https://pypi.org'
/** PEP 508 包名：字母数字开头结尾，中间可含 `.` `_` `-` */
const NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
/** PEP 440 版本的实用子集：数字、`a`/`b`/`rc`/`.post`/`.dev`、`+` 本地段 */
const VERSION_PATTERN = /^[0-9][A-Za-z0-9.!+_-]{0,63}$/
/** 要留在输出里的 info 字段（其余连同 description 一起丢掉） */
const KEEP = [
  'name',
  'version',
  'summary',
  'description_content_type',
  'author',
  'author_email',
  'maintainer',
  'maintainer_email',
  'license',
  'license_expression',
  'requires_python',
  'platform',
  'keywords',
  'home_page',
  'package_url',
  'release_url',
  'project_url',
  'project_urls',
  'provides_extra',
  'classifiers',
  'requires_dist',
  'yanked',
  'yanked_reason',
  'downloads',
] as const

export const params: Record<string, ParamDef[]> = {
  project: [
    { name: 'package', in: 'path', type: 'string', required: true, description: 'PyPI 包名，如 requests / django', maxLength: 100 },
  ],
  release: [
    { name: 'package', in: 'path', type: 'string', required: true, description: 'PyPI 包名', maxLength: 100 },
    { name: 'version', in: 'path', type: 'string', required: true, description: 'PEP 440 版本号，如 2.34.2 / 3.0.0rc1', maxLength: 64 },
  ],
}

export const def: ProviderDef = {
  name: 'pypi',
  displayName: 'PyPI',
  tier: 'A-',
  hosts: ['pypi.org'],
  minIntervalMs: 500,
  uaNote: '官方 JSON API，零 key',
  parseCostMs: 2,
  attribution: '项目元数据与许可证版权归各项目作者，PyPI 只做索引',
  tos: 'https://policies.python.org/pypi.org/Terms-of-Service/',
  limits: '官方未公布硬性限流；本项目 500ms 最小间隔自我约束',
  endpoints: [
    {
      op: 'project',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/pypi/project/{package}',
      summary: '项目元数据（releases 折叠成版本号数组，不含 README 全文）',
      params: params.project ?? [],
      // transform 丢掉 releases/README 全文：上游这个端点动辄 1MB+
      passthrough: false,
      inline: true,
      costMs: 2,
    },
    {
      op: 'release',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/pypi/release/{package}/{version}',
      summary: '单个版本的元数据与文件清单',
      params: params.release ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
  ],
}

export const runtime: ProviderRuntime = {
  name: def.name,
  async buildPlan(env, target): Promise<UpstreamPlan> {
    switch (target.op) {
      case 'project': {
        // PEP 503 归一化：大小写与 -/_/. 等价，统一小写打上游，
        // 免得 Requests 和 requests 各占一条缓存条目
        const name = requireName(target.id)
        return { url: `${API}/pypi/${name.toLowerCase()}/json`, resource: 'item' }
      }
      case 'release': {
        const [name = '', ...rest] = target.id.split('/')
        const version = rest.join('/')
        if (rest.length !== 1) {
          throw fail(ErrorCode.InvalidParameter, `invalid release: ${target.id}`, 400, {
            field: 'package/version',
            value: target.id,
          })
        }
        requireName(name)
        if (!VERSION_PATTERN.test(version) || version.includes('..')) {
          throw fail(ErrorCode.InvalidParameter, `invalid version: ${version}`, 400, { version })
        }
        return { url: `${API}/pypi/${name.toLowerCase()}/${version}/json`, resource: 'item' }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown pypi op: ${target.op}`, 404)
    }
  },

  transform(raw): TransformResult {
    return { text: JSON.stringify(slimProject(raw)), contentType: 'application/json; charset=utf-8' }
  },
}

interface SlimFile {
  filename: string
  packagetype?: string
  python_version?: string
  size?: number
  upload_time?: string
  yanked?: boolean
  yanked_reason?: string
  requires_python?: string
  url?: string
  digests?: Record<string, string>
}

interface SlimProject {
  provider: 'pypi'
  name?: string
  version?: string
  summary?: string
  description_content_type?: string
  [key: string]: unknown
  versions: string[]
  files: SlimFile[]
}

/** 只认 `/pypi/{name}/json` 的固定结构；上游改结构时才需要改这里 */
function slimProject(raw: string): SlimProject {
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw fail(ErrorCode.UpstreamError, 'pypi returned non-JSON', 502)
  }
  const info = (doc.info ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = { provider: 'pypi' }
  for (const key of KEEP) {
    if (info[key] !== undefined && info[key] !== null) out[key] = info[key]
  }
  const releases = (doc.releases ?? {}) as Record<string, unknown>
  out.versions = Object.keys(releases)
  const files = Array.isArray(doc.urls) ? (doc.urls as SlimFile[]) : []
  out.files = files.map((file) => {
    const kept: SlimFile = { filename: file.filename }
    for (const key of ['packagetype', 'python_version', 'size', 'upload_time', 'yanked', 'yanked_reason', 'requires_python', 'url', 'digests'] as const) {
      const value = file[key]
      if (value !== undefined) (kept as unknown as Record<string, unknown>)[key] = value
    }
    return kept
  })
  if (typeof doc.last_serial === 'number') out.last_serial = doc.last_serial
  if (Array.isArray(doc.vulnerabilities)) out.vulnerabilities = doc.vulnerabilities
  return out as SlimProject
}

function requireName(value: string): string {
  if (!NAME_PATTERN.test(value)) {
    throw fail(ErrorCode.InvalidParameter, `invalid package: ${value}`, 400, {
      field: 'package',
      value,
      hint: 'PEP 508 包名：字母数字开头结尾，中间可含 . _ -',
    })
  }
  return value
}
