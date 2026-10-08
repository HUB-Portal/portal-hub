import { For } from 'solid-js';
import { CASE_ADDRESS_LIMITS, STATE_HINT, type CaseAddress, type CaseAddressField, type CaseAddressProblems } from '../lib/caseAddress';
import { COUNTRIES } from '../lib/signup';
import { Field } from './Common';

const LABEL: Record<CaseAddressField, string> = {
  company: 'Company name on the label', fullName: 'Recipient name', email: 'Email address', phone: 'Phone number',
  street: 'Street and number', postalCode: 'Postal code', city: 'City', stateProvince: 'State or province', country: 'Country',
};

const COMPLETE: Record<CaseAddressField, string> = {
  company: 'shipping organization', fullName: 'shipping name', email: 'email', phone: 'tel',
  street: 'shipping street-address', postalCode: 'shipping postal-code', city: 'shipping address-level2', stateProvince: 'shipping address-level1', country: 'shipping country',
};

const HINT: Partial<Record<CaseAddressField, string>> = {
  fullName: 'The person the carrier delivers to.',
  phone: 'Digits, spaces and + - ( ). At most 15 characters, spaces included.',
  stateProvince: STATE_HINT,
};

/**
 * The case address form fields, in one grid. Used by the registration form and by the company profile.
 * `namePrefix` gives each field a name such as "caseStreet" so the page can move focus to the first mistake.
 */
export function CaseAddressFields(props: {
  value: CaseAddress;
  errors: CaseAddressProblems;
  onChange: (field: CaseAddressField, v: string) => void;
  fields: CaseAddressField[];
  namePrefix?: string;
  disabled?: boolean;
  required?: boolean;
  /** Replaces the default field names. */
  names?: Partial<Record<CaseAddressField, string>>;
}) {
  const nameOf = (f: CaseAddressField) => props.names?.[f] ?? `${props.namePrefix ?? 'case'}${f.charAt(0).toUpperCase()}${f.slice(1)}`;
  const required = () => props.required ?? true;
  return (
    <div class="form-grid">
      <For each={props.fields}>
        {(f) => (
          <Field label={LABEL[f]} hint={HINT[f]} error={props.errors[f]}>
            {(p) => f === 'country' ? (
              <select {...p} name={nameOf(f)} value={props.value.country} onChange={(e) => props.onChange(f, e.currentTarget.value)} autocomplete={COMPLETE[f]} required={required()} disabled={props.disabled}>
                <option value="">Choose a country</option>
                <For each={COUNTRIES}>{(c) => <option value={c.code} selected={props.value.country === c.code}>{c.name}</option>}</For>
              </select>
            ) : (
              <input
                {...p}
                name={nameOf(f)}
                type={f === 'email' ? 'email' : f === 'phone' ? 'tel' : 'text'}
                inputMode={f === 'phone' ? 'tel' : undefined}
                value={props.value[f]}
                onInput={(e) => props.onChange(f, e.currentTarget.value)}
                maxLength={CASE_ADDRESS_LIMITS[f] + (f === 'phone' || f === 'postalCode' ? 10 : 0)}
                autocomplete={COMPLETE[f]}
                required={required()}
                disabled={props.disabled}
              />
            )}
          </Field>
        )}
      </For>
    </div>
  );
}
