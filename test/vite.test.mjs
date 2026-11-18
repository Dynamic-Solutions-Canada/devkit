import assert from 'node:assert/strict'
import test from 'node:test'

import { devkitViteServer } from '@dynamic-solutions-canada/devkit/vite'

test('server options come from the environment devkit passes to the container', () => {
  assert.deepEqual(
    devkitViteServer({
      VITE_DEV_PORT: '5174',
      VITE_DEV_HOST: '0.0.0.0',
      VITE_DEV_ALLOWED_HOSTS: 'fix.app.localhost, app.localhost,,localhost',
    }),
    {
      port: 5174,
      host: '0.0.0.0',
      allowedHosts: ['fix.app.localhost', 'app.localhost', 'localhost'],
      watch: { ignored: ['**/.worktrees/**'] },
    },
  )
})

test('without devkit the options fall back to Vite defaults, still skipping worktrees', () => {
  assert.deepEqual(devkitViteServer({}), {
    port: 5173,
    host: true,
    allowedHosts: undefined,
    watch: { ignored: ['**/.worktrees/**'] },
  })
})
