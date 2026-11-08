import { describe, it, expect, vi } from 'vitest'
import { MaterialSupplierService } from '../../src/modules/production/services/material-supplier.service.js'

const MATERIAL = '665f1f77bcf86cd799439011'
const SUPPLIER = '665f1f77bcf86cd799439022'

function fakes(opts: { material?: boolean; supplier?: boolean } = {}) {
  const materials = {
    getById: vi.fn(async (..._a: unknown[]) => (opts.material === false ? null : { id: MATERIAL, name: 'Cera' })),
  }
  const suppliers = {
    getById: vi.fn(async (..._a: unknown[]) => (opts.supplier === false ? null : { id: SUPPLIER, name: 'Proveedor X' })),
  }
  const links = {
    listForMaterial: vi.fn(async (..._a: unknown[]) => [{ supplierId: SUPPLIER, supplierName: 'Proveedor X', isPreferred: true }]),
    link: vi.fn(async (..._a: unknown[]) => undefined),
    unlink: vi.fn(async (..._a: unknown[]) => undefined),
  }
  const service = new MaterialSupplierService(materials as never, suppliers as never, links as never)
  return { service, materials, suppliers, links }
}

describe('material suppliers', () => {
  it('links an existing supplier and returns the updated list in the Lumia shape', async () => {
    const { service, links } = fakes()
    const res = await service.link(MATERIAL, SUPPLIER, true)
    expect(links.link).toHaveBeenCalledWith(MATERIAL, SUPPLIER, true)
    expect(res).toEqual({
      success: true,
      data: { suppliers: [{ supplierId: SUPPLIER, supplierName: 'Proveedor X', isPreferred: true }] },
    })
  })

  it('does not write when the supplier does not exist', async () => {
    const { service, links } = fakes({ supplier: false })
    await expect(service.link(MATERIAL, SUPPLIER, false)).rejects.toThrow(/Proveedor no encontrado/)
    expect(links.link).not.toHaveBeenCalled()
  })

  it('does not write when the material does not exist', async () => {
    const { service, links } = fakes({ material: false })
    await expect(service.link(MATERIAL, SUPPLIER, false)).rejects.toThrow(/Material no encontrado/)
    expect(links.link).not.toHaveBeenCalled()
  })

  it('rejects malformed material ids before querying', async () => {
    const { service, materials } = fakes()
    await expect(service.link('no-es-objectid', SUPPLIER, false)).rejects.toThrow(/inválido/)
    expect(materials.getById).not.toHaveBeenCalled()
  })

  it('unlinks and returns the remaining suppliers', async () => {
    const { service, links } = fakes()
    const res = await service.unlink(MATERIAL, SUPPLIER)
    expect(links.unlink).toHaveBeenCalledWith(MATERIAL, SUPPLIER)
    expect(res.success).toBe(true)
    expect(res.data.suppliers).toHaveLength(1)
  })
})
