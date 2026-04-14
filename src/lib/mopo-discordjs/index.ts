import {
  Client,
  ChatInputCommandInteraction,
  Interaction,
  PermissionResolvable,
  REST,
  Routes,
} from 'discord.js'
import fs from 'fs'
import path from 'path'

export abstract class BaseModule {
  constructor(protected client: Client) {}
  abstract init(): void
}

export interface ApplicationCommandData<T extends BaseModule = BaseModule> {
  name: string
  description: string
  defaultMemberPermissions?: PermissionResolvable
  options?: unknown[]
  execute: (interaction: ChatInputCommandInteraction, module: T) => Promise<void>
}

type ImportFn = (fileUrl: string) => Promise<unknown>

export class ModuleManager {
  private modules = new Map<string, BaseModule>()
  private commands = new Map<string, ApplicationCommandData>()

  constructor(
    private client: Client,
    private importFn: ImportFn,
  ) {}

  async init(basePath: string): Promise<void> {
    await this.loadModules(basePath)
    await this.loadCommands(basePath)
    await this.registerCommands()
  }

  private resolveIndexFile(dir: string): string | null {
    for (const ext of ['ts', 'js']) {
      const p = path.join(dir, `index.${ext}`)
      if (fs.existsSync(p)) return p
    }
    return null
  }

  private async loadModules(basePath: string): Promise<void> {
    const modulesDir = path.join(basePath, 'modules')
    if (!fs.existsSync(modulesDir)) return

    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const indexPath = this.resolveIndexFile(path.join(modulesDir, entry.name))
      if (!indexPath) continue

      const mod = (await this.importFn(indexPath)) as {
        default: new (client: Client) => BaseModule
      }
      const instance = new mod.default(this.client)
      instance.init()
      this.modules.set(entry.name, instance)
      console.log(`[ModuleManager] Loaded module: ${entry.name}`)
    }
  }

  private async loadCommands(basePath: string): Promise<void> {
    const commandsDir = path.join(basePath, 'commands')
    if (!fs.existsSync(commandsDir)) return

    for (const entry of fs.readdirSync(commandsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const indexPath = this.resolveIndexFile(
        path.join(commandsDir, entry.name),
      )
      if (!indexPath) continue

      const mod = (await this.importFn(indexPath)) as {
        default: ApplicationCommandData
      }
      this.commands.set(mod.default.name, mod.default)
      console.log(`[ModuleManager] Loaded command: ${mod.default.name}`)
    }
  }

  private async registerCommands(): Promise<void> {
    if (!this.client.token) {
      console.error(
        '[ModuleManager] No client token available for command registration',
      )
      return
    }
    const appId = this.client.application?.id
    if (!appId) {
      console.error('[ModuleManager] No application ID available')
      return
    }

    const commandData = Array.from(this.commands.values()).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      default_member_permissions:
        cmd.defaultMemberPermissions != null
          ? cmd.defaultMemberPermissions.toString()
          : undefined,
      options: cmd.options,
    }))

    const rest = new REST({ version: '10' }).setToken(this.client.token)
    try {
      await rest.put(Routes.applicationCommands(appId), { body: commandData })
      console.log(`[ModuleManager] Registered ${commandData.length} commands`)
    } catch (err) {
      console.error('[ModuleManager] Failed to register commands:', err)
    }
  }

  async interactionExecute(interaction: Interaction): Promise<void> {
    if (!interaction.isChatInputCommand()) return

    const command = this.commands.get(interaction.commandName)
    if (!command) return

    const module = this.modules.values().next().value
    if (!module) throw new Error('[ModuleManager] No module loaded')

    await command.execute(interaction, module)
  }

  async clearCommands(): Promise<void> {
    if (!this.client.token || !this.client.application?.id) return
    const rest = new REST({ version: '10' }).setToken(this.client.token)
    await rest.put(Routes.applicationCommands(this.client.application.id), {
      body: [],
    })
    console.log('[ModuleManager] Cleared all commands')
  }
}
