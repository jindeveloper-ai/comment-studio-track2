export class PublicSafetyError extends Error {
  readonly category: string;
  constructor(category: string) {
    super('Public source safety check failed. Sensitive details suppressed.');
    this.category = category;
  }
}

export function isPrivatePublicPath(file: string): boolean {
  if (
    !file ||
    file.startsWith('/') ||
    /^[a-z]:/i.test(file) ||
    /[\x00-\x1f\\]/.test(file)
  )
    return true;
  const parts = file.split('/');
  if (parts.some((part) => part === '..')) return true;
  if (file === '.env.example') return false;
  if (
    parts.some((part) =>
      /^(?:\.env(?:\..*)?|\.envrc|\.direnv|\.local|\.secrets|node_modules|dist|artifacts|playwright-report|test-results|chrome-profiles|browser-profiles|browser-data|user-data|backups|screenshots|recordings)$/i.test(
        part,
      ),
    )
  )
    return true;
  if (parts[0] === 'profiles') return true;
  const name = parts.at(-1) || '';
  if (
    /\.env$/i.test(name) ||
    /^(?:cookies?.*\.(?:txt|csv)|.*\.binarycookies)$/i.test(name)
  )
    return true;
  return (
    /^(?:Cookies|Login Data|Local State|Secure Preferences|Preferences|Web Data|History|Network Persistent State|Singleton(?:Lock|Cookie|Socket)|application_default_credentials\.json|client_secret.*\.json|risu-vertex-.*\.json|.*(?:service-account|credentials).*\.json|(?:storage[-_]?state|auth[-_]?state|cookies|tokens?).*\.json)$/i.test(
      name,
    ) ||
    /\.(?:pem|key|sqlite3?|db)(?:-(?:wal|shm))?$/i.test(name) ||
    /\.(?:log|zip|tar|tgz|gz|7z|rar|bak|backup)$/i.test(name)
  );
}

export function assertPublicFile(file: string, bytes: Uint8Array): void {
  if (isPrivatePublicPath(file)) throw new PublicSafetyError('protected_path');
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 16).toString('utf8') === 'SQLite format 3\0')
    throw new PublicSafetyError('database_content');
  if (
    buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) ||
    buffer.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b])) ||
    buffer
      .subarray(0, 6)
      .equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) ||
    buffer.subarray(0, 4).toString('ascii') === 'Rar!' ||
    buffer.subarray(257, 262).toString('ascii') === 'ustar'
  )
    throw new PublicSafetyError('archive_content');
  if (file === '.env.example') {
    for (const line of buffer.toString('utf8').split(/\r?\n/)) {
      const assignment =
        /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (
        assignment &&
        /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|GOOGLE_CLOUD_PROJECT/.test(
          assignment[1],
        ) &&
        !/^(?:|""|'')(?:\s*#.*)?$/.test(assignment[2])
      )
        throw new PublicSafetyError('populated_secret_example');
    }
  }
  if (!/\.json$/i.test(file)) return;
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return;
  }
  const pending = [data];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    const object = value as Record<string, unknown>;
    if (
      object.type === 'service_account' ||
      object.type === 'authorized_user' ||
      (Array.isArray(object.cookies) && Array.isArray(object.origins)) ||
      'os_crypt' in object ||
      'account_info' in object ||
      (typeof object.domain === 'string' &&
        typeof object.name === 'string' &&
        typeof object.value === 'string')
    )
      throw new PublicSafetyError('authentication_json');
    for (const [key, item] of Object.entries(object)) {
      if (
        /^(?:private_?key|client_?secret|refresh_?token|access_?token|id_?token|api_?key|password|encryptedPassword|encryptedUsername)$/i.test(
          key,
        ) &&
        typeof item === 'string' &&
        item.trim()
      )
        throw new PublicSafetyError('authentication_json');
      if (item && typeof item === 'object') pending.push(item);
    }
  }
}
