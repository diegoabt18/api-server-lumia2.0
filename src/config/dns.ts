import dns from 'node:dns'

/**
 * En algunas redes (GPON/ISP) el resolver por defecto rechaza consultas SRV
 * que usa mongodb+srv:// → querySrv ECONNREFUSED en Node.js.
 * Forzar DNS públicos antes de conectar MongoDB Atlas.
 */
export function configureDnsForMongoSrv(): void {
  dns.setServers(['8.8.8.8', '8.8.4.4', '1.1.1.1'])
  dns.setDefaultResultOrder('ipv4first')
}
