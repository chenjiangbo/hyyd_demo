const serviceProductNames: Record<string, string> = {
  '全程专家病房': '住院服务',
  '住院护工协助': '住院护工协助（4天）',
  '全程专家门诊': '全程门诊',
  '全程门诊': '全程门诊',
  '单次门诊': '单次门诊'
}

/** 将泰康服务名称转换为寰宇渠道服务项目名称，未配置的名称沿用原值。 */
export function taikangServiceProductName(name: string): string {
  return Object.prototype.hasOwnProperty.call(serviceProductNames, name) ? serviceProductNames[name]! : name
}
