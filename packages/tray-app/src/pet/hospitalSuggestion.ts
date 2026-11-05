const HOSPITAL_FIELDS = new Set(['hospital', 'hospitalAddress', 'department', 'doctor'])

type SuggestionField = { id: string; value: string | number | boolean; aiPrefill?: boolean; hint?: string }

/** 单项采纳时保留其他医院字段和整组建议。 */
export function applyHospitalSuggestion<T extends SuggestionField>(fields: T[], target: string, value: string): T[] {
  if (!HOSPITAL_FIELDS.has(target)) return fields
  return fields.map((field) => field.id === target ? { ...field, value, aiPrefill: true, hint: undefined } : field)
}
