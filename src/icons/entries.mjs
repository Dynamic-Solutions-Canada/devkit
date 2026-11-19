/**
 * Flattens `icons.json` targets into one entry per output set. A target is an object, except
 * Android, which may also be a list of objects, one per app, because a repo can ship several
 * Android apps but only one web app and one Windows app.
 */

/**
 * Returns every target entry as `{ name, entry, label }`, in config order. `label` names the
 * entry in error messages: `targets.android`, or `targets.android[1]` for a list.
 * Throws on a list for any other target, or an empty Android list.
 */
export function targetEntries(targets) {
  const entries = []
  for (const [name, value] of Object.entries(targets)) {
    if (!Array.isArray(value)) {
      entries.push({ name, entry: value, label: `targets.${name}` })
      continue
    }

    if (name !== 'android') {
      throw new Error(
        `devkit-icons: targets.${name} must be an object; only targets.android takes a list`,
      )
    }
    if (value.length === 0) {
      throw new Error(
        'devkit-icons: targets.android must list at least one app',
      )
    }
    value.forEach((entry, index) => {
      entries.push({ name, entry, label: `targets.${name}[${index}]` })
    })
  }
  return entries
}
