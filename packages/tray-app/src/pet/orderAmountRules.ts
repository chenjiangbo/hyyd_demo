export function orderAmountChange(input: {
  fieldId: string; value: string; previousStatus: string; selectedService: string;
  originalService: string; originalAmount: string; originalStatus: string; servicePrice: string; editable: boolean
}): { amount?: string; editable: boolean; cancelled: boolean; missingPrice: boolean } {
  const status = input.fieldId === 'orderStatus' ? input.value : input.previousStatus
  const cancelled = status === '已取消' || status === '无责取消'
  const wasCancelled = input.previousStatus === '已取消' || input.previousStatus === '无责取消'
  const recalculate = input.fieldId === 'channelService' || (input.fieldId === 'orderStatus' && wasCancelled && !cancelled)
  const amount = cancelled ? '0' : recalculate
    ? input.fieldId === 'channelService' && input.selectedService === input.originalService && !['已取消', '无责取消'].includes(input.originalStatus) ? input.originalAmount : input.servicePrice
    : undefined
  return { amount, cancelled, editable: !cancelled && !recalculate && (input.fieldId === 'amountChanged' ? input.value === 'true' : input.editable), missingPrice: recalculate && !cancelled && !amount }
}
