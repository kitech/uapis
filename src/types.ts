/** 队列消息体。v 为协议版本，未来不兼容变更时递增。 */
export interface RefreshMessage {
  v: 1
  /** 缓存键：`v1:{provider}:{resource}:{normalized_id}:{qhash}` */
  k: string
  /** provider registry 中的名称 */
  p: string
  /** 可解码的刷新目标描述符 `{op}:{encodeURIComponent(id)}?k=v&...` */
  t: string
}

/** Hono 上下文变量与绑定 */
export type AppEnv = {
  Bindings: Env
  Variables: {
    requestId: string
  }
}

declare global {
  interface Env {
    /** /admin/* 使用的唯一 Worker secret */
    ADMIN_TOKEN: string
  }
}
