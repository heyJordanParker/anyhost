import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3'
import { loadSharedConfigFiles } from '@smithy/core/config'

export const PROFILE = 'r2'
const CONNECT_MS = 10_000
const REQUEST_MS = 120_000
// A write gets REQUEST_MS and as long again as its bytes take at 100 KB/s. A Mac whose uploads to R2 moved at 0.4 to
// 0.9 MB/s failed a frame holding a 67 MB tool result, 50 MB compressed, at 120 s on every try. A write the network
// dropped still fails at its limit, which only a total limit gives: Bun never ends an upload that stopped moving for
// the socket's inactivity.
const SLOWEST_UPLOAD_BYTES_PER_MS = 100
const writeTimeoutMs =(bytes: number): number => REQUEST_MS + Math.ceil(bytes / SLOWEST_UPLOAD_BYTES_PER_MS)

export type Stored = { readonly body: Uint8Array; readonly etag: string; readonly modifiedAt: number }
export type Listed = { readonly key: string; readonly size: number }
export type Condition = { readonly ifNoneMatch: '*' } | { readonly ifMatch: string }

export type Store = {
  readonly bucket: string
  get(key: string): Promise<Stored | undefined>
  put(key: string, body: Uint8Array | string, condition?: Condition): Promise<string | undefined>
  list(prefix: string): Promise<Listed[]>
  delete(keys: readonly string[]): Promise<void>
}

export const messageOf = (error: unknown): string => (error instanceof AggregateError ? error.errors.map(String).join(', ') : String(error))

const statusOf = (error: unknown): number | undefined => (error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined)

export async function profileOf(): Promise<{ readonly endpoint: string | undefined; readonly hasKeys: boolean }> {
  const { configFile, credentialsFile } = await loadSharedConfigFiles()
  const keys = credentialsFile[PROFILE]
  return { endpoint: configFile[PROFILE]?.['endpoint_url'], hasKeys: keys?.['aws_access_key_id'] !== undefined && keys['aws_secret_access_key'] !== undefined }
}

async function clientOf(): Promise<S3Client> {
  const { endpoint } = await profileOf()
  if (endpoint === undefined) throw new Error(`The AWS profile ${PROFILE} names no endpoint_url, so anyhost cannot reach R2. anyhost doctor prints the fix.`)
  return new S3Client({ profile: PROFILE, endpoint, requestHandler: { connectionTimeout: CONNECT_MS, requestTimeout: REQUEST_MS, throwOnRequestTimeout: true } })
}

// The bucket the person chose in /config, the option `bucket`, which `cmod options` leaves out until they set it.
export const bucketOf = (chosen: string | undefined): string => chosen || 'anyhost'

export function r2Store(bucket: string): Store {
  let made: Promise<S3Client> | undefined
  const s3 = (): Promise<S3Client> => (made ??= clientOf())
  return {
    bucket,
    async get(key) {
      const answer = await (await s3()).send(new GetObjectCommand({ Bucket: bucket, Key: key })).catch((error: unknown) => {
        if (statusOf(error) === 404) return undefined
        throw error
      })
      if (answer?.Body === undefined) return undefined
      return { body: await answer.Body.transformToByteArray(), etag: answer.ETag ?? '', modifiedAt: answer.LastModified?.getTime() ?? 0 }
    },
    async put(key, body, condition) {
      const answer = await (await s3())
        .send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ...(condition === undefined ? {} : 'ifMatch' in condition ? { IfMatch: condition.ifMatch } : { IfNoneMatch: '*' }) }), {
          requestTimeout: writeTimeoutMs(typeof body === 'string' ? Buffer.byteLength(body) : body.length),
        })
        .catch((error: unknown) => {
          if (condition !== undefined && statusOf(error) === 412) return undefined
          throw error
        })
      return answer === undefined ? undefined : (answer.ETag ?? '')
    },
    async list(prefix) {
      const listed: Listed[] = []
      let token: string | undefined
      do {
        const page = await (await s3()).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }))
        for (const item of page.Contents ?? []) listed.push({ key: item.Key ?? '', size: item.Size ?? 0 })
        token = page.NextContinuationToken
      } while (token !== undefined)
      return listed
    },
    async delete(keys) {
      for (let at = 0; at < keys.length; at += 1000) {
        const answer = await (await s3()).send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(at, at + 1000).map((key) => ({ Key: key })) } }))
        const failed = answer.Errors?.[0]
        if (failed !== undefined) throw new Error(`R2 refused to delete ${failed.Key}: ${failed.Message}`)
      }
    },
  }
}
