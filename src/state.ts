import type { Device as Machine } from '../relay/protocol.ts'

type Account = { readonly id: string; readonly name: string }
export type Connecting = { readonly is: 'running' | 'joined' | 'failed'; readonly lines: readonly string[]; readonly accounts?: readonly Account[]; readonly r2Page?: string; readonly error?: string }
export type Joining = { readonly is: 'running' } | { readonly is: 'failed'; readonly error: string }
export type JoinedRelay = { readonly url: string }
type Candidate = { readonly target: string; readonly os: string; readonly online: boolean }
export type Machines = { readonly here: string; readonly machines: readonly Machine[]; readonly candidates: readonly Candidate[]; readonly adding: readonly { readonly target: string; readonly error?: string }[] }

export type AnyhostState = {
  memory: {
    connecting: Connecting | null
    isFollowing: boolean
    joined: JoinedRelay | { readonly problem: string } | null
    joining: Joining | null
    relayState: string | null
    machines: Machines | null
    isAdding: boolean
    removing: string | null
    problem: string | null
  }
}

export const initialState: AnyhostState = {
  memory: { connecting: null, isFollowing: false, joined: null, joining: null, relayState: null, machines: null, isAdding: false, removing: null, problem: null },
}
