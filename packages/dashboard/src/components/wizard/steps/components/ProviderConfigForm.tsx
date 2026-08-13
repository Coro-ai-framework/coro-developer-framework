import { Input } from '../../../../components/ui/input'
import Field from '../../../../components/forms/field'
import SecretInput from '../../../../components/settings/SecretInput'
import type { PluginAuthFieldDescriptor } from '../../../../lib/plugin-catalog-types'

interface ProviderConfigFormProps {
  title: string
  fields: PluginAuthFieldDescriptor[]
  draft: Record<string, unknown>
  onChange: (key: string, value: string) => void
}

export default function ProviderConfigForm({ title, fields, draft, onChange }: ProviderConfigFormProps) {
  if (fields.length === 0) return null

  return (
    <div className="space-y-3.5 rounded-2xl border border-line bg-overlay/30 p-4">
      <div className="text-sm font-medium text-fg">Configure {title}</div>
      <div className="space-y-3">
        {fields.map(field => (
          <FieldRow
            key={field.key}
            field={field}
            value={typeof draft[field.key] === 'string' ? (draft[field.key] as string) : ''}
            onChange={value => onChange(field.key, value)}
          />
        ))}
      </div>
    </div>
  )
}

function FieldRow({
  field,
  value,
  onChange,
}: {
  field: PluginAuthFieldDescriptor
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Field
      label={field.label}
      hint={field.hint}
      required={field.required}
    >
      {field.kind === 'secret' ? (
        <SecretInput
          value={value}
          placeholder={field.placeholder}
          onChange={event => onChange(event.target.value)}
        />
      ) : (
        <Input
          type={field.kind === 'url' ? 'url' : 'text'}
          value={value}
          placeholder={field.placeholder}
          onChange={event => onChange(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      )}
    </Field>
  )
}
