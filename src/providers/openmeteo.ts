import { ErrorCode, fail } from '../core/errors'
import { queryValue } from '../core/target'
import type { Target } from '../core/target'
import type { ParamDef, ProviderDef } from '../core/registry'
import type { Resource } from '../core/ttl'
import type { UpstreamPlan, ProviderRuntime } from './runtime'

/**
 * Open-Meteo 免费 API，零 key。
 * <https://open-meteo.com/en/docs> · 条款 <https://open-meteo.com/en/terms>
 *
 * ⚠️ **条款限定非商业用途**（CC BY 4.0）：官方把"运营带订阅或广告的网站/应用"
 * 明确列为商业使用，并保留不经通知封禁应用/IP 的权利。公开部署前请自行确认
 * 你的部署算非商业；商业化需要换成 `customer-` 前缀的 host 并带 `apikey`。
 *
 * 实测出来、直接决定参数上界的四件事：
 *
 * 1. **体积完全不是问题，所以纯透传**：current 327B、hourly 8 变量 × 16 天 20,595B、
 *    空气质量 9 变量 × 7 天 10,863B。离 512KB 上限差两个数量级——这和 PyPI/crates
 *    要做 transform 的原因正好相反，那些是因为响应有 500KB。
 * 2. **限流只存在于条款里，响应头一个都没有**：600/分钟、5,000/小时、10,000/天、
 *    300,000/月。绑定约束是**每日 10,000**，而 `credits.ts` 的 quota 表本来就是按天计的，
 *    所以额度取 4000（他们日上限的 40%），闸门 1000ms 远在 600/分钟之内。
 * 3. **"看起来成功其实没数据"的坑有三个**，全都在本地挡掉：
 *    - 坐标合法但**一个变量都不给** → `200` + 171B，只有元数据没有数据
 *    - geocoding `name=` 传空 → `200` + `{generationtime_ms}`，**没有 `results` 键**
 *    - geocoding 查无此城 → `200` + 同样形态，但这个是**真·查不到**，应当照常透传
 *    放行前两个等于把"200 但零数据"缓存下来，之后谁都命中这个空条目。
 * 4. **变量名拼错时上游会把 Scala 内部类名漏进 reason**
 *    （`Cannot initialize SurfacePressureAndHeightVariable<...`），
 *    所以变量表在本地校验，未知值直接 400，用户看不到上游的实现细节。
 *
 * 顺带记两个上游自己的 bug：`forecast_days=99` 的报错文案是
 * "Allowed range 0 to 16. **Given 16**."（把入参回显成了默认值），
 * 所以范围在本地卡住，不指望上游的报错文案。
 *
 * 坐标参数声明为 `type: 'number'` 并给上下界，校验由框架的 `validate()` 兜住
 * （`minimum`/`maximum` 曾经只对 `integer` 生效，number 是走过场的）。
 */
const FORECAST = 'https://api.open-meteo.com/v1/forecast'
const GEOCODING = 'https://geocoding-api.open-meteo.com/v1/search'
const AIR_QUALITY = 'https://air-quality-api.open-meteo.com/v1/air-quality'

/** 天气变量表：只放实测能拿到的常用项，不做上游那 100+ 个变量的全集 */
const CURRENT_VARS = [
  'temperature_2m',
  'relative_humidity_2m',
  'apparent_temperature',
  'dew_point_2m',
  'precipitation',
  'rain',
  'showers',
  'snowfall',
  'weather_code',
  'cloud_cover',
  'pressure_msl',
  'surface_pressure',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'is_day',
] as const

/** hourly 表在 current 表基础上多两项有累积语义的量（降水概率、可见度） */
const HOURLY_VARS = [...CURRENT_VARS, 'precipitation_probability', 'visibility'] as const

/**
 * 空气质量变量表与天气表**完全不重叠**，所以必须是独立的白名单：
 * 上游把 `Cannot initialize SurfacePressureAndHeightVariable<...` 塞进 reason，
 * 混用表必然 400。
 */
const AQ_VARS = [
  'pm10',
  'pm2_5',
  'carbon_monoxide',
  'nitrogen_dioxide',
  'sulphur_dioxide',
  'ozone',
  'aerosol_optical_depth',
  'dust',
  'uv_index',
  'european_aqi',
  'us_aqi',
] as const

const TEMPERATURE_UNITS = ['celsius', 'fahrenheit'] as const
const WIND_SPEED_UNITS = ['kmh', 'ms', 'mph', 'kn'] as const
const PRECIPITATION_UNITS = ['mm', 'inch'] as const
/**
 * 时区白名单收窄成三种固定值 + IANA 形态（`Europe/Berlin`、`Asia/Shanghai`、`UTC`）。
 * IANA 全集 600+ 个没法穷举，但形态足够窄：`Region/City`、`Region/Sub_City`、
 * 以及单段的 `UTC`/`GMT`。坏时区交给上游 400。
 */
const TIMEZONE_PATTERN = /^(?:auto|UTC|GMT|[A-Za-z_]+(?:\/[A-Za-z_+-][A-Za-z_+\-0-9]*)+)$/
/**
 * 变量数上界就是白名单长度（current 18 / hourly 20 / 空气质量 11），不另设 count 上限：
 * 384 个时间点 × 20 个变量实测在 50KB 量级（8 变量 × 16 天是 20,595B），
 * 白名单之外的量能进来就已经是 bug 了，再加一个永远触发不到的死分支没有意义。
 */
const PLACE_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} \p{P}]{0,99}$/u

const ALLOWED_FORECAST = {
  current: CURRENT_VARS,
  hourly: HOURLY_VARS,
} as const

export const params: Record<string, ParamDef[]> = {
  current: [
    { name: 'latitude', in: 'query', type: 'number', required: true, description: '纬度，-90 到 90', minimum: -90, maximum: 90 },
    { name: 'longitude', in: 'query', type: 'number', required: true, description: '经度，-180 到 180', minimum: -180, maximum: 180 },
    { name: 'current', in: 'query', type: 'string', required: true, description: '当前观测变量，逗号分隔（见 docs）', maxLength: 400 },
    { name: 'timezone', in: 'query', type: 'string', required: false, description: 'auto（默认）/UTC/GMT/IANA 名', default: 'auto' },
    { name: 'temperature_unit', in: 'query', type: 'string', required: false, description: 'celsius/fahrenheit', default: 'celsius' },
    { name: 'wind_speed_unit', in: 'query', type: 'string', required: false, description: 'kmh/ms/mph/kn', default: 'kmh' },
    { name: 'precipitation_unit', in: 'query', type: 'string', required: false, description: 'mm/inch', default: 'mm' },
  ],
  hourly: [
    { name: 'latitude', in: 'query', type: 'number', required: true, description: '纬度，-90 到 90', minimum: -90, maximum: 90 },
    { name: 'longitude', in: 'query', type: 'number', required: true, description: '经度，-180 到 180', minimum: -180, maximum: 180 },
    { name: 'hourly', in: 'query', type: 'string', required: true, description: '逐小时变量，逗号分隔（见 docs）', maxLength: 400 },
    { name: 'forecast_days', in: 'query', type: 'integer', required: false, description: '预报天数，1-16', default: '7', minimum: 1, maximum: 16 },
    { name: 'timezone', in: 'query', type: 'string', required: false, description: 'auto（默认）/UTC/GMT/IANA 名', default: 'auto' },
    { name: 'temperature_unit', in: 'query', type: 'string', required: false, description: 'celsius/fahrenheit', default: 'celsius' },
    { name: 'wind_speed_unit', in: 'query', type: 'string', required: false, description: 'kmh/ms/mph/kn', default: 'kmh' },
    { name: 'precipitation_unit', in: 'query', type: 'string', required: false, description: 'mm/inch', default: 'mm' },
  ],
  geocode: [
    { name: 'name', in: 'query', type: 'string', required: true, description: '地名，如 Wichita', maxLength: 100 },
    { name: 'count', in: 'query', type: 'integer', required: false, description: '返回条数，1-100', default: '5', minimum: 1, maximum: 100 },
    { name: 'language', in: 'query', type: 'string', required: false, description: '两位语言码', default: 'en', maxLength: 2 },
  ],
  'air-quality': [
    { name: 'latitude', in: 'query', type: 'number', required: true, description: '纬度，-90 到 90', minimum: -90, maximum: 90 },
    { name: 'longitude', in: 'query', type: 'number', required: true, description: '经度，-180 到 180', minimum: -180, maximum: 180 },
    { name: 'current', in: 'query', type: 'string', required: false, description: '当前空气质量变量，逗号分隔' },
    { name: 'hourly', in: 'query', type: 'string', required: false, description: '逐小时空气质量变量，逗号分隔' },
    { name: 'forecast_days', in: 'query', type: 'integer', required: false, description: '预报天数，1-7', default: '1', minimum: 1, maximum: 7 },
    { name: 'timezone', in: 'query', type: 'string', required: false, description: 'auto（默认）/UTC/GMT/IANA 名', default: 'auto' },
  ],
}

export const def: ProviderDef = {
  name: 'openmeteo',
  displayName: 'Open-Meteo',
  tier: 'A-',
  hosts: ['api.open-meteo.com', 'geocoding-api.open-meteo.com', 'air-quality-api.open-meteo.com'],
  minIntervalMs: 1000,
  uaNote: '免费 API 零 key，官方未强制 UA 但要求合理使用；本项目发 uapis/1.0 (+SITE_URL)',
  parseCostMs: 0,
  attribution: '气象与空气质量数据由 Open-Meteo.com 提供，CC BY 4.0',
  tos: 'https://open-meteo.com/en/terms',
  limits: '条款值 600/分钟、5,000/小时、10,000/天、300,000/月（响应头不含任何限流信息）；本项目 1000ms 最小间隔、每日额度 4000',
  endpoints: [
    {
      op: 'current',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/openmeteo/current',
      summary: '当前观测（实测 327B；上游 interval=900s，本档 TTL 600s）',
      params: params.current ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'hourly',
      resource: 'feed',
      method: 'GET',
      path: '/api/v1/openmeteo/hourly',
      summary: '逐小时预报（8 变量 × 16 天实测 20,595B）',
      params: params.hourly ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'geocode',
      resource: 'search',
      method: 'GET',
      path: '/api/v1/openmeteo/geocode',
      summary: '地名检索（实测 1,394B；查无此城时上游只回 generationtime_ms，属正常透传）',
      params: params.geocode ?? [],
      passthrough: true,
      inline: true,
      costMs: 0,
    },
    {
      op: 'air-quality',
      resource: 'item',
      method: 'GET',
      path: '/api/v1/openmeteo/air-quality',
      summary: '空气质量（current 实测 384B；hourly 9 变量 × 7 天 10,863B，实测最慢 3.3s）',
      params: params['air-quality'] ?? [],
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
      case 'current':
      case 'hourly': {
        const resource: Resource = target.op === 'current' ? 'item' : 'feed'
        const query = [`latitude=${queryValue(target, 'latitude')}`, `longitude=${queryValue(target, 'longitude')}`]
        query.push(`${target.op}=${requireVars(queryValue(target, target.op), ALLOWED_FORECAST[target.op])}`)
        if (target.op === 'hourly') query.push(`forecast_days=${queryValue(target, 'forecast_days') ?? '7'}`)
        query.push(...unitParams(target))
        return {
          url: `${FORECAST}?${query.join('&')}`,
          resource,
          // 实测 1.5-2.0s；空气质量最慢，所以这里给 5s
          timeoutMs: 5000,
          retries: 0,
        }
      }
      case 'geocode': {
        const name = queryValue(target, 'name') ?? ''
        if (!PLACE_PATTERN.test(name)) {
          throw fail(ErrorCode.InvalidParameter, `invalid name: ${name}`, 400, {
            parameter: 'name',
            value: name,
            hint: '空地名上游会回 200 但只有 generationtime_ms、没有 results，所以在这里挡掉',
          })
        }
        const language = queryValue(target, 'language') ?? 'en'
        if (!/^[a-z]{2}$/.test(language)) {
          throw fail(ErrorCode.InvalidParameter, `invalid language: ${language}`, 400, {
            parameter: 'language',
            value: language,
            hint: '两位小写语言码，如 en / zh',
          })
        }
        return {
          // format=json 写死：默认值本来就是 JSON，写死是为了上游哪天改默认值时打不到我们
          url: `${GEOCODING}?name=${encodeURIComponent(name)}&count=${queryValue(target, 'count') ?? '5'}&language=${language}&format=json`,
          resource: 'search',
          timeoutMs: 5000,
          retries: 0,
        }
      }
      case 'air-quality': {
        const current = queryValue(target, 'current')
        const hourly = queryValue(target, 'hourly')
        if ((current ?? '') === '' && (hourly ?? '') === '') {
          throw fail(ErrorCode.InvalidParameter, 'current 与 hourly 至少要有一个', 400, {
            parameter: 'current',
            hint: '一个变量都不给时上游回 200 但只有元数据没有数据；空气质量变量表与天气表不通用',
          })
        }
        const query = [`latitude=${queryValue(target, 'latitude')}`, `longitude=${queryValue(target, 'longitude')}`]
        if ((current ?? '') !== '') query.push(`current=${requireVars(current, AQ_VARS)}`)
        if ((hourly ?? '') !== '') query.push(`hourly=${requireVars(hourly, AQ_VARS)}`)
        query.push(`forecast_days=${queryValue(target, 'forecast_days') ?? '1'}`)
        const timezone = queryValue(target, 'timezone') ?? 'auto'
        if (!TIMEZONE_PATTERN.test(timezone)) {
          throw fail(ErrorCode.InvalidParameter, `invalid timezone: ${timezone}`, 400, {
            parameter: 'timezone',
            value: timezone,
            allowed: ['auto', 'UTC', 'GMT', 'Region/City'],
          })
        }
        query.push(`timezone=${timezone}`)
        return {
          url: `${AIR_QUALITY}?${query.join('&')}`,
          resource: 'item',
          // 实测 3.3s，超过默认 3s——必须显式放宽
          timeoutMs: 8000,
          retries: 0,
        }
      }
      default:
        throw fail(ErrorCode.NotFound, `unknown openmeteo op: ${target.op}`, 404)
    }
  },
}

/** 三个单位枚举对 forecast 的两个 op 都一样；air-quality 不支持单位换算 */
function unitParams(target: Target): string[] {
  const temperature = queryValue(target, 'temperature_unit') ?? 'celsius'
  const wind = queryValue(target, 'wind_speed_unit') ?? 'kmh'
  const precipitation = queryValue(target, 'precipitation_unit') ?? 'mm'
  if (!(TEMPERATURE_UNITS as readonly string[]).includes(temperature)) {
    throw fail(ErrorCode.InvalidParameter, `invalid temperature_unit: ${temperature}`, 400, {
      parameter: 'temperature_unit',
      allowed: [...TEMPERATURE_UNITS],
    })
  }
  if (!(WIND_SPEED_UNITS as readonly string[]).includes(wind)) {
    throw fail(ErrorCode.InvalidParameter, `invalid wind_speed_unit: ${wind}`, 400, {
      parameter: 'wind_speed_unit',
      allowed: [...WIND_SPEED_UNITS],
    })
  }
  if (!(PRECIPITATION_UNITS as readonly string[]).includes(precipitation)) {
    throw fail(ErrorCode.InvalidParameter, `invalid precipitation_unit: ${precipitation}`, 400, {
      parameter: 'precipitation_unit',
      allowed: [...PRECIPITATION_UNITS],
    })
  }
  const timezone = queryValue(target, 'timezone') ?? 'auto'
  if (!TIMEZONE_PATTERN.test(timezone)) {
    throw fail(ErrorCode.InvalidParameter, `invalid timezone: ${timezone}`, 400, {
      parameter: 'timezone',
      value: timezone,
      allowed: ['auto', 'UTC', 'GMT', 'Region/City'],
    })
  }
  return [
    `timezone=${timezone}`,
    `temperature_unit=${temperature}`,
    `wind_speed_unit=${wind}`,
    `precipitation_unit=${precipitation}`,
  ]
}

/**
 * 变量表校验：逗号分隔、每段必须在白名单里。
 * 这里必须自己挡，原因是上游把 Scala 内部类名漏进错误 reason
 * （`Cannot initialize SurfacePressureAndHeightVariable<...`），
 * 直接透传等于把上游实现细节甩给调用方。
 */
function requireVars(value: string | undefined, allowed: readonly string[]): string {
  const raw = (value ?? '').split(',').map((part) => part.trim())
  if (raw.some((part) => part.length === 0)) {
    throw fail(ErrorCode.InvalidParameter, '变量表里有空段（多了一个逗号或首尾有空白）', 400, {
      allowed: [...allowed],
    })
  }
  const unknown = raw.filter((part) => !(allowed as readonly string[]).includes(part))
  if (unknown.length > 0) {
    throw fail(ErrorCode.InvalidParameter, `未知天气变量: ${unknown.join(',')}`, 400, {
      allowed: [...allowed],
    })
  }
  return raw.join(',')
}
