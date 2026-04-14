import {
  Client,
  ClientOptions,
  DiscordAPIError,
  GatewayIntentBits,
  HTTPError,
} from 'discord.js'
import path from 'path'

import { ModuleManager } from '@/lib/mopo-discordjs'
import { env } from '@/utils/env'

const options: ClientOptions = {
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  waitGuildTimeout: 60000,
  rest: { timeout: 60000 },
}
const client = new Client(options)
const moduleManager = new ModuleManager(
  client,
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  async (fileUrl) => await import(fileUrl),
)

client.on('interactionCreate', (interaction) => {
  void (async (): Promise<void> => {
    try {
      await moduleManager.interactionExecute(interaction)
    } catch (err) {
      console.error('Error while executing interaction:')
      if (interaction.isCommand() || interaction.isAutocomplete())
        console.error('commandName:', interaction.commandName)
      if (interaction.isMessageComponent() || interaction.isModalSubmit())
        console.error('customId:', interaction.customId)

      if (
        !(err instanceof HTTPError && err.message === 'Service Unavailable') &&
        !(
          err instanceof DiscordAPIError &&
          err.message === 'Unknown interaction'
        )
      )
        throw err
      console.error(err)
    }
  })()
})

client.on('ready', () => {
  void (async (): Promise<void> => {
    console.log('--- Bot is ready ---')
    console.log('--- [1/2]Clearing commands ---')
    console.log('--skipping command clearing--')
    // await moduleManager.clearCommands()
    console.log('--- [2/2]Initializing modules ---')
    await moduleManager.init(path.join(__dirname))
    console.log('--  Bot successfully started --')
  })()
})
void client.login(env.BOT_TOKEN)
