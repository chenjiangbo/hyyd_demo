export type PinganMedicalField = { id: string | null; name: string }
export type PinganMedical = Record<'hospital' | 'address' | 'department' | 'doctor', PinganMedicalField>

export function pinganMedicalFields(current: Record<string, string>, match: PinganMedical): Record<string, { value: string; displayFallback?: string; hint?: string }> {
  const hospital = current.hospital?.trim() || match.hospital.id || match.hospital.name || ''
  const sameHospital = Boolean(hospital && (hospital === match.hospital.id || hospital === match.hospital.name))
  const department = current.department?.trim() || (sameHospital ? match.department.id || match.department.name : '') || ''
  const sameDepartment = Boolean(department && (department === match.department.id || department === match.department.name))
  return Object.fromEntries(([
    ['hospital', 'hospital', true], ['hospitalAddress', 'address', sameHospital],
    ['department', 'department', sameHospital], ['doctor', 'doctor', sameHospital && sameDepartment]
  ] as const).map(([id, key, compatible]) => {
    const existing = (current[id] ?? '').trim()
    const field = match[key]
    if (existing) return [id, { value: existing }]
    if (compatible) return [id, { value: field.id || field.name }]
    return [id, { value: '', ...(field.name ? { displayFallback: field.name } : {}) }]
  }))
}
