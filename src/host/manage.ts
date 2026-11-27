import type { HostController } from './controller.js'
import {
  handleAddPublicNode,
  handleCheckPublicNode,
  handleConfirmPublicNodeIdentity,
  handleRemovePublicNode,
  handleSetCurrentPublicNode,
} from './public-node-actions.js'

interface ManageActionSpec {
  localOnly: boolean
  localOnlyMessage?: string
  run: (controller: HostController, input: Record<string, unknown>, local: boolean) => Promise<unknown> | unknown
}

const ACTIONS: Record<string, ManageActionSpec> = {
  status: {
    localOnly: false,
    run: (controller, _input, local) => controller.status(local),
  },
  requests: {
    localOnly: false,
    run: (controller, _input, local) => controller.requestsStatus(local),
  },
  start: {
    localOnly: false,
    run: async (controller, _input, local) => {
      if (!controller.isEnabled()) await controller.start()
      return controller.status(local)
    },
  },
  reloadLanCertificate: {
    localOnly: true,
    localOnlyMessage: '局域网证书只能在本机面板重载。',
    run: async (controller, _input, local) => {
      await controller.reloadLanCertificate()
      return controller.status(local)
    },
  },
  switch: {
    localOnly: false,
    run: (controller, _input, local) => controller.switchMode(local),
  },
  stop: {
    localOnly: false,
    run: (controller, _input, local) => controller.stopByCaller(local),
  },
  refresh: {
    localOnly: false,
    run: async (controller, _input, local) => {
      await controller.refresh()
      return controller.status(local)
    },
  },
  approve: {
    localOnly: true,
    localOnlyMessage: '首次配对必须在本机确认。',
    run: (controller, input, local) => {
      controller.approvePairing(input)
      return controller.status(local)
    },
  },
  reject: {
    localOnly: true,
    localOnlyMessage: '配对请求由本机处理。',
    run: (controller, input, local) => {
      controller.rejectPairing(String(input.id))
      return controller.status(local)
    },
  },
  revoke: {
    localOnly: false,
    run: (controller, input) => controller.scheduleRevoke(String(input.id)),
  },
  rename: {
    localOnly: false,
    run: (controller, input, local) => {
      controller.renameDevice(String(input.id), String(input.name ?? ''))
      return controller.status(local)
    },
  },
  revokeAll: {
    localOnly: false,
    run: (controller) => controller.scheduleRevokeAll(),
  },
  preferences: {
    localOnly: false,
    run: async (controller, input, local) => {
      await controller.updatePreferences(input, local)
      return controller.status(local)
    },
  },
  checkPublicUrl: {
    localOnly: true,
    localOnlyMessage: '公网检测只能在本机面板执行。',
    run: async (controller, _input, local) => {
      await controller.checkPublicUrl()
      return controller.status(local)
    },
  },
  certificate: {
    localOnly: true,
    localOnlyMessage: '证书只能在本机面板管理。',
    run: (controller, _input, local) => {
      controller.requestCertificate()
      return controller.status(local)
    },
  },
  addPublicNode: {
    localOnly: true,
    localOnlyMessage: '公网节点只能在本机面板添加。',
    run: (controller, input) => handleAddPublicNode(controller.publicNodeDeps(), input),
  },
  checkPublicNode: {
    localOnly: true,
    localOnlyMessage: '公网节点只能在本机面板检测。',
    run: (controller, input) => handleCheckPublicNode(controller.publicNodeDeps(), input),
  },
  confirmPublicNodeIdentity: {
    localOnly: true,
    localOnlyMessage: '公网节点身份必须在本机面板确认。',
    run: (controller, input) => handleConfirmPublicNodeIdentity(controller.publicNodeDeps(), input),
  },
  setCurrentPublicNode: {
    localOnly: true,
    localOnlyMessage: '公网节点只能在本机面板切换。',
    run: async (controller, input, local) => {
      await handleSetCurrentPublicNode(controller.publicNodeDeps(), input)
      return controller.status(local)
    },
  },
  removePublicNode: {
    localOnly: true,
    localOnlyMessage: '公网节点只能在本机面板删除。',
    run: async (controller, input, local) => {
      await handleRemovePublicNode(controller.publicNodeDeps(), input)
      return controller.status(local)
    },
  },
  approveServicePairing: {
    localOnly: true,
    localOnlyMessage: '首次配对必须在本机确认。',
    run: (controller, input, local) => {
      controller.approveServicePairing(String(input.id ?? ''))
      return controller.status(local)
    },
  },
  rejectServicePairing: {
    localOnly: true,
    localOnlyMessage: '配对请求由本机处理。',
    run: (controller, input, local) => {
      controller.rejectServicePairing(String(input.id ?? ''))
      return controller.status(local)
    },
  },
}

export function createManageHandler(
  getController: () => HostController,
): (input: Record<string, unknown>, local: boolean) => Promise<unknown> {
  return async (input: Record<string, unknown>, local: boolean): Promise<unknown> => {
    const action = typeof input.action === 'string' ? input.action : ''
    const spec = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined
    if (!spec) throw new Error('未知的远程控制操作。')
    if (spec.localOnly && !local) throw new Error(spec.localOnlyMessage ?? '该操作仅限本机面板执行。')
    return spec.run(getController(), input, local)
  }
}
