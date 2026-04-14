import {
  AudioReceiveStream,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import crypto from 'crypto'
import {
  AttachmentBuilder,
  Channel,
  TextChannel,
  VoiceState,
  Webhook,
} from 'discord.js'
import fs from 'fs'
import { IOptions, nodewhisper } from 'nodejs-whisper'
import path from 'path'
import prism from 'prism-media'
import shell from 'shelljs'
import { pipeline } from 'stream/promises'

import { BaseModule } from '@/lib/mopo-discordjs'
import { ModelName } from '@/types/ModelName'
export interface TranscriptionOption {
  sendRealtimeMessage: boolean
  exportReport: boolean
  exportAudio: boolean
  sendChannelId?: string
}

interface GuildSession {
  queue: {
    uuid: string
    userId: string
    sendChannelId: string
    guildId: string
  }[]
  isQueueProcessing: boolean
  option: TranscriptionOption
  report: string
  audioRecordings: {
    uuid: string
    userId: string
    startTime: number
    endTime?: number
    filePath: string
  }[]
  sessionStartTime: number
  onCompleteCallback?: () => Promise<void>
  subscribedUsers: Set<string>
}

export default class Transcription extends BaseModule {
  private static readonly TEMP_DIR = path.resolve(
    __dirname, // transcription
    '../', // modules
    '../', // app
    '../', // src
    '../', // project root
    'temp',
  )

  private static readonly OUTPUT_DIR = path.resolve(
    __dirname, // transcription
    '../', // modules
    '../', // app
    '../', // src
    '../', // project root
    'output',
  )

  private static readonly AFTER_SILENCE_DURATION = 800 // ms

  private static readonly whisperOptions: IOptions = {
    modelName: ModelName.LARGE_V3_TURBO,
    autoDownloadModelName: ModelName.LARGE_V3_TURBO,
    removeWavFileAfterTranscription: false,
    withCuda: true,
    logger: console,
    whisperOptions: {
      outputInCsv: false,
      outputInJson: false,
      outputInJsonFull: false,
      outputInLrc: false,
      outputInSrt: false,
      outputInText: false,
      outputInVtt: false,
      outputInWords: false,
      translateToEnglish: false,
      language: 'ja',
      wordTimestamps: false,
      timestamps_length: 20,
      splitOnWord: true,
    },
  }

  private guildSessions = new Map<string, GuildSession>()

  private static getGuildTempDir(guildId: string): string {
    return path.join(Transcription.TEMP_DIR, guildId)
  }

  private static ensureGuildTempDir(guildId: string): void {
    const guildDir = Transcription.getGuildTempDir(guildId)
    if (!fs.existsSync(guildDir)) fs.mkdirSync(guildDir, { recursive: true })
  }

  private static saveReportToOutput(
    report: string,
    sessionStartTime: number,
  ): void {
    if (!fs.existsSync(Transcription.OUTPUT_DIR))
      fs.mkdirSync(Transcription.OUTPUT_DIR, { recursive: true })

    const date = new Date(sessionStartTime)
    const timestamp = date
      .toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' })
      .replace(/[: ]/g, '-')
    const outputPath = path.join(Transcription.OUTPUT_DIR, `${timestamp}.txt`)
    fs.writeFileSync(outputPath, report, 'utf-8')
    console.log(`[discord-whisper]Report saved to: ${outputPath}`)
  }

  public getGuildInProgress(guildId: string): boolean {
    const session = this.guildSessions.get(guildId)
    return session
      ? session.isQueueProcessing || session.queue.length > 0
      : false
  }

  public stopAndExport(
    guildId: string,
    onComplete?: () => Promise<void>,
  ): boolean {
    const connection = getVoiceConnection(guildId)
    if (!connection) return false

    const session = this.guildSessions.get(guildId)
    if (session && onComplete) session.onCompleteCallback = onComplete

    connection.destroy()
    return true
  }

  public init(): void {
    this.client.on(
      'voiceStateUpdate',
      (oldState: VoiceState, newState: VoiceState): void => {
        void (async (): Promise<void> => {
          const connection = getVoiceConnection(newState.guild.id)
          if (!connection?.joinConfig.channelId) return
          if (oldState.channelId !== connection.joinConfig.channelId) return

          const channel = await newState.guild.channels.fetch(
            connection.joinConfig.channelId,
          )
          if (!channel?.isVoiceBased()) return

          const unBotMembers = channel.members.filter(
            (member) => !member.user.bot,
          )
          if (unBotMembers.size === 0) {
            connection.destroy()
            return
          }
        })()
      },
    )
  }

  public start(connection: VoiceConnection, option: TranscriptionOption): void {
    const guildId = connection.joinConfig.guildId
    const session = this.getOrCreateGuildSession(guildId)
    session.option = option

    console.log(
      `[discord-whisper]start() called, connection state: ${connection.state.status}`,
    )

    connection.on('stateChange', (oldState, newState) => {
      console.log(
        `[discord-whisper]Connection state changed: ${oldState.status} -> ${newState.status}`,
      )
    })

    connection.on('debug', (message) => {
      console.log(`[discord-whisper][debug] ${message}`)
    })

    void entersState(connection, VoiceConnectionStatus.Ready, 30_000)
      .then(() => {
        console.log('[discord-whisper]Connection reached Ready state')
      })
      .catch(() => {
        console.error(
          '[discord-whisper]Connection failed to reach Ready state within 30s, destroying',
        )
        connection.destroy()
      })

    connection.receiver.speaking.on('start', (userId) => {
      if (session.subscribedUsers.has(userId)) {
        console.log(
          `[discord-whisper]User ${userId} is already subscribed, skipping`,
        )
        return
      }

      console.log(`[discord-whisper]User ${userId} started speaking`)
      const uuid = crypto.randomUUID()
      const currentTime = Date.now()

      if (session.option.exportAudio) {
        Transcription.ensureGuildTempDir(guildId)
        session.audioRecordings.push({
          uuid: uuid,
          userId: userId,
          startTime: currentTime,
          filePath: path.join(
            Transcription.getGuildTempDir(guildId),
            `${uuid}.wav`,
          ),
        })
      }

      const opusStream = connection.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: Transcription.AFTER_SILENCE_DURATION,
        },
      })

      session.subscribedUsers.add(userId)

      opusStream.on('end', () => {
        void (async (): Promise<void> => {
          if (!connection.joinConfig.channelId) {
            console.warn(
              '[discord-whisper]No channel ID found in connection join config',
            )
            return
          }
          console.log(`[discord-whisper]Stream from user ${userId} has ended`)

          session.subscribedUsers.delete(userId)
          if (session.option.exportAudio) {
            console.log(
              `[discord-whisper]Looking for recording with UUID: ${uuid}`,
            )

            const recording = session.audioRecordings.find(
              (r) => r.uuid === uuid,
            )

            if (recording) {
              recording.endTime = Date.now()
              console.log(
                `[discord-whisper]Set endTime for UUID ${uuid}: ${String(recording.endTime)}`,
              )
            } else {
              console.warn(
                `[discord-whisper]Recording not found for UUID: ${uuid}`,
              )
            }
          }

          opusStream.destroy()
          await this.encodePcmToWav(guildId, uuid)
          if (this.isValidVoiceData(guildId, uuid)) {
            session.queue.push({
              uuid: uuid,
              userId: userId,
              sendChannelId:
                session.option.sendChannelId ?? connection.joinConfig.channelId,
              guildId: guildId,
            })
            if (!session.isQueueProcessing) await this.progressQueue(guildId)
          }
          fs.unlinkSync(
            path.join(Transcription.getGuildTempDir(guildId), `${uuid}.pcm`),
          )
        })()
      })

      opusStream.on('error', (error) => {
        console.error(
          `[discord-whisper]Stream error for user ${userId}:`,
          error,
        )
        session.subscribedUsers.delete(userId)
        opusStream.destroy()
      })

      void this.encodeOpusToPcm(guildId, uuid, opusStream)
    })

    connection.on(VoiceConnectionStatus.Ready, () => {
      console.log(
        '[discord-whisper]The connection has entered the Ready state - ready to play audio!',
      )
    })

    connection.on(VoiceConnectionStatus.Disconnected, () => {
      void (async (): Promise<void> => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ])
        } catch {
          connection.destroy()
        }
      })()
    })

    connection.on(VoiceConnectionStatus.Destroyed, () => {
      console.log('[discord-whisper]The connection has been destroyed')

      session.subscribedUsers.clear()

      const interval = setInterval(() => {
        void (async (): Promise<void> => {
          if (session.queue.length === 0) {
            clearInterval(interval)
            const sendChannelId =
              session.option.sendChannelId ?? connection.joinConfig.channelId
            if (sendChannelId && session.option.exportReport) {
              Transcription.ensureGuildTempDir(guildId)
              const reportPath = path.join(
                Transcription.getGuildTempDir(guildId),
                `report_${guildId}.txt`,
              )
              fs.writeFileSync(reportPath, session.report)
              Transcription.saveReportToOutput(
                session.report,
                session.sessionStartTime,
              )
              const channel = await this.client.channels.fetch(sendChannelId)
              const attachment = new AttachmentBuilder(reportPath)
              if (channel?.isTextBased()) {
                await (channel as TextChannel).send({
                  content: '今回のレポート:',
                  files: [attachment],
                })
              }
            }

            if (
              sendChannelId &&
              session.option.exportAudio &&
              session.audioRecordings.length > 0
            ) {
              const mergedAudioPath = await this.mergeAudioFiles(
                guildId,
                session,
              )
              if (mergedAudioPath) {
                const channel = await this.client.channels.fetch(sendChannelId)
                const audioAttachment = new AttachmentBuilder(mergedAudioPath)
                if (channel?.isTextBased()) {
                  await (channel as TextChannel)
                    .send({
                      content: '録音ファイル:',
                      files: [audioAttachment],
                    })
                    .catch(() => undefined)
                }
              }
            }
            console.log('[discord-whisper]Queue is empty, stopping interval')

            if (session.onCompleteCallback) await session.onCompleteCallback()

            this.cleanupTempFiles(guildId)
            this.guildSessions.delete(guildId)
            return
          }
        })()
      }, 1000)
    })
  }

  private getOrCreateGuildSession(guildId: string): GuildSession {
    if (!this.guildSessions.has(guildId)) {
      this.guildSessions.set(guildId, {
        queue: [],
        isQueueProcessing: false,
        option: {
          sendRealtimeMessage: true,
          exportReport: true,
          exportAudio: true,
        },
        report: '',
        audioRecordings: [],
        sessionStartTime: Date.now(),
        subscribedUsers: new Set<string>(),
      })
    }
    const session = this.guildSessions.get(guildId)
    if (!session)
      throw new Error(`Failed to create session for guild ${guildId}`)
    return session
  }

  private async encodeOpusToPcm(
    guildId: string,
    uuid: string,
    opusStream: AudioReceiveStream,
  ): Promise<void> {
    const opusDecoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48000,
    })

    Transcription.ensureGuildTempDir(guildId)
    const out = fs.createWriteStream(
      path.join(Transcription.getGuildTempDir(guildId), `${uuid}.pcm`),
    )
    await pipeline(
      opusStream as unknown as NodeJS.ReadableStream,
      opusDecoder as unknown as NodeJS.WritableStream,
      out as unknown as NodeJS.WritableStream,
    ).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE')
        throw err
    })
  }

  private async encodePcmToWav(guildId: string, uuid: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      console.log(`[discord-whisper]Encoding PCM to WAV for UUID: ${uuid}`)
      const pcmFilePath = path.join(
        Transcription.getGuildTempDir(guildId),
        `${uuid}.pcm`,
      )
      const wavFilePath = path.join(
        Transcription.getGuildTempDir(guildId),
        `${uuid}.wav`,
      )

      const command = `ffmpeg -f s16le -ar 48k -ac 2 -i "${pcmFilePath}" "${wavFilePath}"`
      const result = shell.exec(command)
      if (result.code !== 0)
        reject(new Error(`Failed to encode PCM to WAV: ${result.stderr}`))
      resolve()
    })
  }

  private async transcribeAudio(
    guildId: string,
    uuid: string,
  ): Promise<string | undefined> {
    console.log(`[discord-whisper]Transcribing audio for UUID: ${uuid}`)
    const wavFilePath = path.join(
      Transcription.getGuildTempDir(guildId),
      `${uuid}.wav`,
    )
    if (!fs.existsSync(wavFilePath)) {
      console.error(`[discord-whisper]WAV file not found: ${wavFilePath}`)
      return
    }
    const context = await nodewhisper(
      wavFilePath,
      Transcription.whisperOptions,
    ).catch((error: unknown) => {
      console.error(
        `[discord-whisper]Error during transcription for UUID ${uuid}:`,
        error,
      )
      return ''
    })

    const cleanedContext = context.replace(/(?=\[).*?(?<=\])\s\s/g, '')

    if (!this.isValidJapaneseTranscription(cleanedContext)) {
      console.warn(
        `[discord-whisper]Transcription failed Japanese validation: "${cleanedContext}"`,
      )
      return undefined
    }

    return cleanedContext
  }

  private async fetchWebhook(channel: Channel): Promise<Webhook | undefined> {
    if (!channel.isTextBased()) return
    const textChannel = channel as TextChannel
    const webhooks = await textChannel.fetchWebhooks()
    return (
      webhooks.find((v: Webhook) => v.token) ??
      (await textChannel.createWebhook({
        name: this.client.user?.username ?? 'Transcription Bot',
      }))
    )
  }

  private async sendWebhookMessage(
    webhook: Webhook,
    userId: string,
    message: string,
  ): Promise<void> {
    try {
      const user = await this.client.users.fetch(userId)
      const guild = await this.client.guilds.fetch(webhook.guildId)
      const member = await guild.members.fetch(userId).catch(() => undefined)

      const webhookOption = {
        username: member?.displayName ?? user.displayName,
        avatarURL: member?.displayAvatarURL() ?? user.displayAvatarURL(),
      }

      await webhook.send({
        ...webhookOption,
        content: message,
      })
      console.log('[discord-whisper]Webhook message sent successfully')
    } catch (error) {
      console.error('[discord-whisper]Error sending webhook message:', error)
    }
  }

  private async progressQueue(guildId: string): Promise<void> {
    const session = this.getOrCreateGuildSession(guildId)
    session.isQueueProcessing = true
    const completedItem = session.queue.shift()
    if (completedItem) {
      const context = await this.transcribeAudio(
        completedItem.guildId,
        completedItem.uuid,
      )
      if (context) {
        if (completedItem.sendChannelId && session.option.sendRealtimeMessage) {
          const channel = await this.client.channels.fetch(
            completedItem.sendChannelId,
          )
          if (channel?.isTextBased()) {
            const webhook = await this.fetchWebhook(channel)
            if (webhook) {
              await this.sendWebhookMessage(
                webhook,
                completedItem.userId,
                context,
              )
            }
          }
        }
        if (session.option.exportReport) {
          const user = await this.client.users.fetch(completedItem.userId)
          session.report += `${user.displayName}: ${context}\n`
        }
      }
    }
    if (session.queue.length > 0) void this.progressQueue(guildId)
    else session.isQueueProcessing = false
  }

  private isValidVoiceData(guildId: string, uuid: string): boolean {
    const pcmFilePath = path.join(
      Transcription.getGuildTempDir(guildId),
      `${uuid}.pcm`,
    )
    if (!fs.existsSync(pcmFilePath)) {
      console.warn(`[discord-whisper]PCM file not found: ${pcmFilePath}`)
      return false
    }

    const stats = fs.statSync(pcmFilePath)
    const fileSizeInBytes = stats.size
    const durationInSeconds = fileSizeInBytes / (48000 * 2 * 2) // 48kHz, 2 channels, 2 bytes per sample

    if (durationInSeconds < 0.5) {
      console.warn(
        `[discord-whisper]PCM file too short: ${pcmFilePath} (${durationInSeconds.toString()}s)`,
      )
      return false
    }

    if (durationInSeconds > 30) {
      console.warn(
        `[discord-whisper]PCM file too long: ${pcmFilePath} (${durationInSeconds.toString()}s)`,
      )
      return false
    }

    if (!this.hasValidAudioLevel(pcmFilePath)) {
      console.warn(
        `[discord-whisper]PCM file has insufficient audio level: ${pcmFilePath}`,
      )
      return false
    }

    if (!this.detectVoiceActivity(pcmFilePath, durationInSeconds)) {
      console.warn(
        `[discord-whisper]No voice activity detected: ${pcmFilePath}`,
      )
      return false
    }

    console.log(
      `[discord-whisper]PCM file is valid: ${pcmFilePath} (${durationInSeconds.toString()}s)`,
    )
    return true
  }

  private hasValidAudioLevel(pcmFilePath: string): boolean {
    try {
      const pcmData = fs.readFileSync(pcmFilePath)
      let sumSquared = 0
      let maxAmplitude = 0
      const sampleCount = pcmData.length / 2 // 16-bit samples

      // Reads PCM data as 16-bit samples and calculates RMS
      for (let i = 0; i < pcmData.length; i += 2) {
        const sample = pcmData.readInt16LE(i)
        const amplitude = Math.abs(sample)
        sumSquared += sample * sample
        maxAmplitude = Math.max(maxAmplitude, amplitude)
      }

      const rms = Math.sqrt(sumSquared / sampleCount)
      const rmsDb = 20 * Math.log10(rms / 32767) // dB calculation based on 16-bit max

      // Volume threshold: above -40dB, max amplitude above 1000
      const hasValidRms = rmsDb > -40
      const hasValidPeak = maxAmplitude > 1000

      console.log(
        `[discord-whisper]Audio level check - RMS: ${rmsDb.toFixed(2)}dB, Peak: ${maxAmplitude.toString()}, Valid: ${String(hasValidRms && hasValidPeak)}`,
      )

      return hasValidRms && hasValidPeak
    } catch (error) {
      console.error('[discord-whisper]Error analyzing audio level:', error)
      return false
    }
  }

  private detectVoiceActivity(
    pcmFilePath: string,
    durationInSeconds: number,
  ): boolean {
    try {
      const pcmData = fs.readFileSync(pcmFilePath)
      const sampleRate = 48000
      const channels = 2
      const frameSize = Math.floor(sampleRate * 0.025) * channels * 2 // 25ms frames
      const frameCount = Math.floor(pcmData.length / frameSize)

      let voiceFrames = 0
      const energyThreshold = 1000000 // Energy threshold

      // Future expansion: dynamic threshold adjustment using durationInSeconds is possible
      // Currently using fixed threshold
      const adaptiveThreshold =
        durationInSeconds > 2 ? energyThreshold * 0.8 : energyThreshold

      for (let frame = 0; frame < frameCount; frame++) {
        const frameStart = frame * frameSize
        const frameEnd = Math.min(frameStart + frameSize, pcmData.length)
        let frameEnergy = 0

        for (let i = frameStart; i < frameEnd; i += 2) {
          const sample = pcmData.readInt16LE(i)
          frameEnergy += sample * sample
        }

        if (frameEnergy > adaptiveThreshold) voiceFrames++
      }

      const voiceRatio = voiceFrames / frameCount
      const minVoiceRatio = 0.1 // Audio must be detected in at least 10% of frames

      console.log(
        `[discord-whisper]VAD analysis - Voice frames: ${voiceFrames.toString()}/${frameCount.toString()} (${(voiceRatio * 100).toFixed(1)}%), Valid: ${String(voiceRatio >= minVoiceRatio)}`,
      )

      return voiceRatio >= minVoiceRatio
    } catch (error) {
      console.error(
        '[discord-whisper]Error in voice activity detection:',
        error,
      )
      return false
    }
  }

  private isValidJapaneseTranscription(text: string): boolean {
    if (!text || text.trim().length === 0) return false

    const trimmedText = text.trim()

    if (trimmedText.length < 2) return false

    if (trimmedText.length > 200) {
      console.warn(
        `[discord-whisper]Transcription too long (${trimmedText.length.toString()} chars)`,
      )
      return false
    }

    const commonFalsePositives = [
      'ありがとうございました',
      'お疲れ様でした',
      'ご視聴ありがとうございました',
      'そうですね',
      'はい',
      'いえ',
      'うん',
      'そう',
      '...',
      '。。。',
      'えーと',
      'あのー',
      'まあ',
      'ちょっと',
      'Thank you',
      'thank you',
    ]

    if (trimmedText.length <= 10) {
      const isCommonFalsePositive = commonFalsePositives.some((pattern) =>
        trimmedText.includes(pattern),
      )
      if (isCommonFalsePositive) {
        console.warn(
          `[discord-whisper]Filtered common false positive: "${trimmedText}"`,
        )
        return false
      }
    }

    const japaneseCharRegex = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/
    const hasJapaneseChars = japaneseCharRegex.test(trimmedText)

    const englishOnlyRegex = /^[a-zA-Z\s.,!?]+$/
    const isEnglishOnly = englishOnlyRegex.test(trimmedText)

    if (isEnglishOnly) {
      console.warn(
        `[discord-whisper]Filtered English-only transcription: "${trimmedText}"`,
      )
      return false
    }

    const symbolOnlyRegex = /^[.,!?。、！？\s\-_]+$/
    const isSymbolOnly = symbolOnlyRegex.test(trimmedText)

    if (isSymbolOnly) {
      console.warn(
        `[discord-whisper]Filtered symbol-only transcription: "${trimmedText}"`,
      )
      return false
    }

    if (!hasJapaneseChars) {
      console.warn(
        `[discord-whisper]No Japanese characters found: "${trimmedText}"`,
      )
      return false
    }

    console.log(
      `[discord-whisper]Valid Japanese transcription: "${trimmedText}"`,
    )
    return true
  }

  private cleanupTempFiles(guildId: string): void {
    const guildDir = Transcription.getGuildTempDir(guildId)
    if (fs.existsSync(guildDir)) {
      try {
        const files = fs.readdirSync(guildDir)
        files.forEach((file) => {
          if (file.startsWith('merged_audio_')) return
          const filePath = path.join(guildDir, file)
          fs.unlinkSync(filePath)
          console.log(`[discord-whisper]Deleted temp file: ${file}`)
        })
        console.log(
          `[discord-whisper]Deleted guild temp directory: ${guildDir}`,
        )
      } catch (error) {
        console.error(
          `[discord-whisper]Error cleaning up temp files for guild ${guildId}:`,
          error,
        )
      }
    }
  }

  private async mergeAudioFiles(
    guildId: string,
    session: GuildSession,
  ): Promise<string | null> {
    try {
      console.log(`[discord-whisper]Merging audio files for guild ${guildId}`)

      const validRecordings = session.audioRecordings.filter(
        (recording) => recording.endTime && fs.existsSync(recording.filePath),
      )

      if (validRecordings.length === 0) {
        console.warn(
          `[discord-whisper]No valid recordings found for guild ${guildId}`,
        )
        return null
      }

      validRecordings.sort((a, b) => a.startTime - b.startTime)

      const outputPath = path.join(
        Transcription.getGuildTempDir(guildId),
        `merged_audio_${guildId}.wav`,
      )

      const inputFiles = validRecordings.map((recording, index) => {
        const silence = this.calculateSilenceDuration(
          session.sessionStartTime,
          recording.startTime,
          validRecordings,
          index,
        )
        return {
          file: recording.filePath,
          silence: silence,
          userId: recording.userId,
        }
      })

      await this.mergeWithFFmpeg(inputFiles, outputPath)

      console.log(
        `[discord-whisper]Audio files merged successfully: ${outputPath}`,
      )
      return outputPath
    } catch (error) {
      console.error(`[discord-whisper]Error merging audio files:`, error)
      return null
    }
  }

  private calculateSilenceDuration(
    sessionStart: number,
    recordingStart: number,
    allRecordings: GuildSession['audioRecordings'],
    currentIndex: number,
  ): number {
    if (currentIndex === 0) {
      return Math.max(0, recordingStart - sessionStart)
    } else {
      const previousRecording = allRecordings[currentIndex - 1]
      const previousEndTime =
        previousRecording.endTime ?? previousRecording.startTime
      return Math.max(0, recordingStart - previousEndTime)
    }
  }

  private async mergeWithFFmpeg(
    inputFiles: { file: string; silence: number; userId: string }[],
    outputPath: string,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      try {
        let command = 'ffmpeg -y'
        let filterComplex = ''

        inputFiles.forEach((input) => {
          command += ` -i "${input.file}"`
        })

        let concatInputs = ''
        inputFiles.forEach((input, index) => {
          if (input.silence > 0) {
            const silenceDurationSec = input.silence / 1000
            filterComplex += `anullsrc=channel_layout=stereo:sample_rate=48000:duration=${silenceDurationSec.toString()}[silence${index.toString()}];`
            concatInputs += `[silence${index.toString()}][${index.toString()}:a]`
          } else {
            concatInputs += `[${index.toString()}:a]`
          }
        })

        filterComplex += `${concatInputs}concat=n=${(inputFiles.length * 2).toString()}:v=0:a=1[out]`

        command += ` -filter_complex "${filterComplex}" -map "[out]" "${outputPath}"`

        console.log(`[discord-whisper]Executing ffmpeg command: ${command}`)

        const result = shell.exec(command)
        if (result.code !== 0)
          reject(new Error(`FFmpeg failed: ${result.stderr}`))
        else resolve()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
}
