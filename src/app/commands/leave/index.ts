import { getVoiceConnection } from '@discordjs/voice'
import { PermissionFlagsBits } from 'discord.js'
import { ChatInputCommandInteraction } from 'discord.js'

import Transcription from '@/app/modules/transcription'
import { ApplicationCommandData } from '@/lib/mopo-discordjs'

export default {
  name: 'leave',
  description: 'BOTをチャンネルから切断します',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  execute: async (
    interaction: ChatInputCommandInteraction,
    module,
  ): Promise<void> => {
    await interaction.deferReply({
      ephemeral: true,
    })
    if (!interaction.guild) {
      await interaction.editReply({
        content: 'このコマンドはサーバー内でのみ使用できます。',
      })
      return
    }

    const member = await interaction.guild.members
      .fetch(interaction.user.id)
      .catch(() => undefined)
    if (!member) {
      await interaction.editReply({
        content: 'メンバー情報を取得できませんでした。',
      })
      return
    }

    if (!member.voice.channel) {
      await interaction.editReply({
        content: '貴方はボイスチャンネルに参加していません。',
      })
      return
    }

    const connection = getVoiceConnection(interaction.guild.id)
    if (!connection) {
      await interaction.editReply({
        content: 'ボイスチャンネルに接続していません。',
      })
      return
    }
    await interaction.editReply({
      content: '処理を停止しています...',
    })

    const hasSession = module.getGuildInProgress(interaction.guild.id)
    const stopped = module.stopAndExport(interaction.guild.id, async () => {
      await interaction.editReply({
        content: hasSession
          ? 'ボイスチャンネルから切断しました。レポートと音声ファイルの出力が完了しました。'
          : 'ボイスチャンネルから切断しました。',
      })
    })

    if (!stopped) {
      await interaction.editReply({
        content: 'ボイスチャンネルに接続していません。',
      })
    }
  },
} as const satisfies ApplicationCommandData<Transcription>
