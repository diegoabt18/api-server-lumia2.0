import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto'

/**
 * Firma de grants de operación (JWS compacto, EdDSA/Ed25519). La clave privada solo vive en el
 * Server; los agentes reciben la pública en `session.ready` y verifican cada orden con ella.
 *
 * DESKTOP_GRANT_SIGNING_KEY: semilla Ed25519 de 32 bytes en base64url (43 caracteres). Generar con:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
 */

/** Cabecera DER PKCS#8 de una clave privada Ed25519; le sigue la semilla de 32 bytes. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export const GRANT_ISSUER = 'lumia-server'

export interface GrantKey {
  kid: string
  public_key: string
}

export interface GrantClaims {
  iss: string
  aud: string
  jti: string
  task_id: string
  sub: string
  op: string
  args: unknown
  iat: number
  exp: number
}

export class GrantSigner {
  private readonly privateKey: KeyObject
  readonly key: GrantKey

  constructor(seed: Buffer) {
    if (seed.length !== 32)
      throw new Error('DESKTOP_GRANT_SIGNING_KEY must be 32 bytes (base64url, 43 characters)')
    this.privateKey = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
      format: 'der',
      type: 'pkcs8',
    })
    const publicKey = createPublicKey(this.privateKey).export({ format: 'jwk' }).x as string
    // kid derivado de la clave pública: rotar la clave cambia el kid sin configuración extra.
    const kid = createHash('sha256').update(publicKey).digest('base64url').slice(0, 16)
    this.key = { kid, public_key: publicKey }
  }

  /** Clave de la configuración o, fuera de producción, una efímera (los grants no sobreviven a un reinicio). */
  static fromEnv(
    value: string | undefined,
    nodeEnv: string,
    log?: { warn: (obj: object, msg: string) => void },
  ): GrantSigner {
    if (value) return new GrantSigner(Buffer.from(value, 'base64url'))
    if (nodeEnv === 'production') {
      throw new Error(
        'DESKTOP_GRANT_SIGNING_KEY is required when DESKTOP_AGENT_ENABLED=true in production',
      )
    }
    log?.warn(
      {},
      'DESKTOP_GRANT_SIGNING_KEY not set: using an ephemeral grant key (development only)',
    )
    const { privateKey } = generateKeyPairSync('ed25519')
    const der = privateKey.export({ format: 'der', type: 'pkcs8' })
    return new GrantSigner(Buffer.from(der.subarray(der.length - 32)))
  }

  keys(): GrantKey[] {
    return [this.key]
  }

  sign(claims: GrantClaims): string {
    const header = Buffer.from(
      JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: this.key.kid }),
    ).toString('base64url')
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
    const input = `${header}.${body}`
    const signature = sign(null, Buffer.from(input), this.privateKey).toString('base64url')
    return `${input}.${signature}`
  }
}
