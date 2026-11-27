import { build } from 'tsdown'
import { bootConfig } from '../tsdown.config.js'

export default async function setup(): Promise<void> {
  await build({ ...bootConfig, config: false, logLevel: 'silent' })
}
