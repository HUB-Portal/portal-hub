// The command list. Kept free of imports so that "cli --help" and "cli gen-key" work before any settings exist.
export const CLI_USAGE = `Usage: cli <command>
  migrate                         apply database migrations (and create or update the app role)
  seed [--force]                  create demo data (--force wipes first; development only)
  create-admin --email E --name N [--google]
                                  create a K Line administrator and print a one time invite link
                                  (--google: the person signs in with Google Workspace, no password or link)
  demo-accounts                   list the demo accounts with their live authenticator codes (DEMO_MODE only)
  gen-key [--id ID]               print a new master key to add to MASTER_KEYS
  audit-verify                    verify the audit log hash chain
  audit-trim --months N           remove audit entries older than N months
  rewrap [--dry-run] [--only KIND[,KIND]] [--batch N]
                                  move file keys and encrypted fields to the active master key (ACTIVE_KEY_ID).
                                  KIND: files | patient_names | instructions | file_names | totp | webhooks | portal_keys | blind_index
  retention                       purge expired cases and clean old records (also runs daily in the worker)
  portal-sync                     read case statuses from the K Line portal now (also runs every 10 minutes in the worker)`;
