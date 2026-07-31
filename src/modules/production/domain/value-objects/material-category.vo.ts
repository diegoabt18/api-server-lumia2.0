export const MATERIAL_CATEGORY = {
  CERAS: 'ceras',
  PARAFINAS: 'parafinas',
  FRAGANCIAS: 'fragancias',
  COLORANTES: 'colorantes',
  PABILOS: 'pabilos',
  CEMENTOS: 'cementos',
  ADITIVOS: 'aditivos',
  PEGANTES: 'pegantes',
  CARTONES: 'cartones',
  PAPELES: 'papeles',
  ENVASES: 'envases',
  EMPAQUES: 'empaques',
  DECORACIONES: 'decoraciones',
  OTROS: 'otros',
} as const

export type MaterialCategory = (typeof MATERIAL_CATEGORY)[keyof typeof MATERIAL_CATEGORY]

export const ALL_MATERIAL_CATEGORIES: MaterialCategory[] = Object.values(MATERIAL_CATEGORY)

export function isValidMaterialCategory(value: string): value is MaterialCategory {
  return ALL_MATERIAL_CATEGORIES.includes(value as MaterialCategory)
}
