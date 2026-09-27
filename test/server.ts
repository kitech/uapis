import { setupNetwork } from '@msw/cloudflare'

/** 出站请求全部走 MSW 拦截，测试不依赖真实网络 */
export const network = setupNetwork()
