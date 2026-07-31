export interface CurrencyConfig {
  name: string
  code: string
  symbol: string
  prefix: string
  suffix: string
  decimalPlaces: number
  decimalSeparator: string
  thousandsSeparator: string
  spaceBetween: boolean
  symbolPosition: 'before' | 'after'
  showCode: boolean
}

export const DEFAULT_CURRENCY_CONFIG: CurrencyConfig = {
  name: 'Peso Colombiano',
  code: 'COP',
  symbol: '$',
  prefix: '',
  suffix: '',
  decimalPlaces: 0,
  decimalSeparator: ',',
  thousandsSeparator: '.',
  spaceBetween: false,
  symbolPosition: 'before',
  showCode: false,
}
