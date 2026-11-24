import type { Db } from 'mongodb'
import {
  MongoDesktopDeviceStore,
  MongoDesktopEnrollmentStore,
  MongoPendingRegistrationStore,
  type DesktopDeviceStore,
} from './infrastructure/desktop-device.repository.js'
import {
  MongoDesktopExecutionStore,
  type DesktopExecutionStore,
} from './infrastructure/desktop-execution.repository.js'
import {
  MongoDesktopApprovalStore,
  type DesktopApprovalStore,
} from './infrastructure/desktop-approval.repository.js'
import { GrantSigner } from './infrastructure/grant-signer.js'
import type { PendingActionStore } from '../actions/pending-action.js'
import type { LumiDesktopPort } from '../tools/tool.types.js'
import { createLumiDesktopPort } from './services/lumi-desktop-port.js'
import { DesktopGateway } from './services/desktop-gateway.js'
import { DesktopEnrollmentService } from './services/enrollment.service.js'
import { DesktopExecutionService } from './services/execution.service.js'
import { DesktopTransferService } from './services/transfer.service.js'

export interface DesktopAgentServices {
  devices: DesktopDeviceStore
  executions: DesktopExecutionStore
  enrollment: DesktopEnrollmentService
  gateway: DesktopGateway
  execution: DesktopExecutionService
  /** Transferencias de archivos (fase 6): el Server retransmite, no guarda. */
  transfers: DesktopTransferService
  approvals: DesktopApprovalStore
  /** Puerto de Lumi Chat (herramientas `device.*`). */
  lumiPort: LumiDesktopPort
  shutdown(): void
}

type Logger = {
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
}

/** Ensambla los servicios del agente con cualquier almacenamiento (Mongo o memoria). */
export function assembleDesktopAgentServices(deps: {
  devices: DesktopDeviceStore
  executions: DesktopExecutionStore
  enrollment: DesktopEnrollmentService
  signer: GrantSigner
  approvals: DesktopApprovalStore
  pending: PendingActionStore
  log?: Logger
}): DesktopAgentServices {
  const gateway = new DesktopGateway({
    devices: deps.devices,
    grantKeys: () => deps.signer.keys(),
    log: deps.log,
  })
  const execution = new DesktopExecutionService({
    devices: deps.devices,
    executions: deps.executions,
    signer: deps.signer,
    transport: gateway,
    log: deps.log,
  })
  gateway.setTaskHandler(execution)
  const lumiPort = createLumiDesktopPort({
    devices: deps.devices,
    isOnline: (id) => gateway.isOnline(id),
    execution,
    approvals: deps.approvals,
    pending: deps.pending,
  })
  return {
    devices: deps.devices,
    executions: deps.executions,
    enrollment: deps.enrollment,
    gateway,
    execution,
    transfers: new DesktopTransferService(execution),
    approvals: deps.approvals,
    lumiPort,
    shutdown: () => {
      execution.shutdown()
      gateway.shutdown()
    },
  }
}

/** Servicios del agente de escritorio sobre identity_db (como el resto de Lumi). */
export async function createDesktopAgentServices(
  db: Db,
  log: Logger,
  options: { grantSigningKey: string | undefined; nodeEnv: string; pending: PendingActionStore },
): Promise<DesktopAgentServices> {
  const devices = new MongoDesktopDeviceStore(db)
  const enrollments = new MongoDesktopEnrollmentStore(db)
  const registrations = new MongoPendingRegistrationStore(db)
  const executions = new MongoDesktopExecutionStore(db)
  const approvals = new MongoDesktopApprovalStore(db)
  await Promise.all([
    approvals.ensureIndexes().catch((err) => log.warn({ err }, 'desktop approval indexes skipped')),
    devices.ensureIndexes().catch((err) => log.warn({ err }, 'desktop device indexes skipped')),
    enrollments
      .ensureIndexes()
      .catch((err) => log.warn({ err }, 'desktop enrollment indexes skipped')),
    registrations
      .ensureIndexes()
      .catch((err) => log.warn({ err }, 'desktop registration indexes skipped')),
    executions
      .ensureIndexes()
      .catch((err) => log.warn({ err }, 'desktop execution indexes skipped')),
  ])
  return assembleDesktopAgentServices({
    devices,
    executions,
    enrollment: new DesktopEnrollmentService({ devices, enrollments, registrations }),
    signer: GrantSigner.fromEnv(options.grantSigningKey, options.nodeEnv, log),
    approvals,
    pending: options.pending,
    log,
  })
}
