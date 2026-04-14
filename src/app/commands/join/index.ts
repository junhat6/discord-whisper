import {
  DiscordGatewayAdapterCreator,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice'
import { ApplicationCommandOptionType, PermissionFlagsBits } from 'discord.js'
import { ChatInputCommandInteraction } from 'discord.js'
import { ApplicationCommandData } from '@/lib/mopo-discordjs'

import Transcription from '@/app/modules/transcription'

export default {
  name: 'join',
  description: 'ボイスチャンネルに参加して音声転写を開始します',
  defaultMemberPermissions: PermissionFlagsBits.Administrator,
  options: [
    {
      name: 'realtime',
      description: 'リアルタイムメッセージ送信を有効にする',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
    {
      name: 'report',
      description: '退室時のレポート出力を有効にする',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
    {
      name: 'audio',
      description: '音声ファイルの録音・出力を有効にする',
      type: ApplicationCommandOptionType.Boolean,
      required: false,
    },
  ],
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

    if (module.getGuildInProgress(interaction.guild.id)) {
      await interaction.editReply({
        content: '現在、別の処理が実行中です。しばらくお待ちください。',
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

    if (getVoiceConnection(interaction.guild.id)) {
      await interaction.editReply({
        content: 'すでにボイスチャンネルに接続しています。',
      })
      return
    }

    if (!member.voice.channel) {
      await interaction.editReply({
        content: '貴方はボイスチャンネルに参加していません。',
      })
      return
    }

    const connection = joinVoiceChannel({
      channelId: member.voice.channel.id,
      guildId: interaction.guild.id,
      adapterCreator: interaction.guild
        .voiceAdapterCreator as DiscordGatewayAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      debug: true,
    })

    const sendRealtimeMessage =
      interaction.options.getBoolean('realtime') ?? true
    const exportReport = interaction.options.getBoolean('report') ?? true
    const exportAudio = interaction.options.getBoolean('audio') ?? true

    module.start(connection, {
      sendRealtimeMessage,
      exportReport,
      exportAudio,
    })

    await interaction.editReply({
      content: `ボイスチャンネル<#${member.voice.channel.id}>に参加しました。`,
    })
  },
} as const satisfies ApplicationCommandData<Transcription>
