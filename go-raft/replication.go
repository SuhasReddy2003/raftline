package raft

// AppendEntriesArgs is sent by the leader to replicate log entries to a
// follower, or with an empty Entries slice to serve as a heartbeat.
type AppendEntriesArgs struct {
	Term         int
	LeaderID     string
	PrevLogIndex int
	PrevLogTerm  int
	Entries      []LogEntry
	LeaderCommit int
}

// AppendEntriesReply is sent back in response to an AppendEntries call.
type AppendEntriesReply struct {
	Term    int
	Success bool
}

func (n *Node) lastLogIndex() int {
	if len(n.Log) == 0 {
		return 0
	}
	return n.Log[len(n.Log)-1].Index
}

func (n *Node) lastLogTerm() int {
	if len(n.Log) == 0 {
		return 0
	}
	return n.Log[len(n.Log)-1].Term
}

func (n *Node) termAtIndex(index int) (term int, ok bool) {
	if index == 0 {
		return 0, true
	}
	for _, entry := range n.Log {
		if entry.Index == index {
			return entry.Term, true
		}
	}
	return 0, false
}

func (n *Node) truncateLogFrom(index int) {
	kept := make([]LogEntry, 0, len(n.Log))
	for _, entry := range n.Log {
		if entry.Index < index {
			kept = append(kept, entry)
		}
	}
	n.Log = kept
}

// HandleAppendEntries is called on a node when it receives an AppendEntries
// RPC from a leader. Implements both log replication and heartbeats, plus
// Raft's consistency and safety rules.
func (n *Node) HandleAppendEntries(args AppendEntriesArgs) AppendEntriesReply {
	if args.Term < n.CurrentTerm {
		return AppendEntriesReply{Term: n.CurrentTerm, Success: false}
	}

	if args.Term > n.CurrentTerm {
		n.CurrentTerm = args.Term
		n.VotedFor = ""
	}
	n.State = Follower

	if args.PrevLogIndex > 0 {
		prevTerm, ok := n.termAtIndex(args.PrevLogIndex)
		if !ok || prevTerm != args.PrevLogTerm {
			return AppendEntriesReply{Term: n.CurrentTerm, Success: false}
		}
	}

	for _, newEntry := range args.Entries {
		existingTerm, exists := n.termAtIndex(newEntry.Index)
		if exists {
			if existingTerm != newEntry.Term {
				n.truncateLogFrom(newEntry.Index)
				n.Log = append(n.Log, newEntry)
			}
		} else {
			n.Log = append(n.Log, newEntry)
		}
	}

	if args.LeaderCommit > n.CommitIndex {
		lastNewIndex := args.PrevLogIndex
		if len(args.Entries) > 0 {
			lastNewIndex = args.Entries[len(args.Entries)-1].Index
		}
		n.CommitIndex = min(args.LeaderCommit, lastNewIndex)
	}

	return AppendEntriesReply{Term: n.CurrentTerm, Success: true}
}

// MakeAppendEntries builds the AppendEntries RPC a leader should send to a
// specific follower, based on that follower's NextIndex. If the follower is
// fully caught up, Entries will be empty — this is what makes AppendEntries
// double as a heartbeat.
func (n *Node) MakeAppendEntries(peerID string) AppendEntriesArgs {
	nextIdx := n.NextIndex[peerID]
	if nextIdx == 0 {
		nextIdx = n.lastLogIndex() + 1
	}

	prevLogIndex := nextIdx - 1
	prevLogTerm, _ := n.termAtIndex(prevLogIndex)

	var entries []LogEntry
	for _, entry := range n.Log {
		if entry.Index >= nextIdx {
			entries = append(entries, entry)
		}
	}

	return AppendEntriesArgs{
		Term:         n.CurrentTerm,
		LeaderID:     n.ID,
		PrevLogIndex: prevLogIndex,
		PrevLogTerm:  prevLogTerm,
		Entries:      entries,
		LeaderCommit: n.CommitIndex,
	}
}

// HandleAppendEntriesReply processes a follower's response, updating
// leader-side tracking state and advancing CommitIndex once a majority
// has replicated a new entry. peerIDs is the full set of other node IDs
// in the cluster (excluding this leader).
func (n *Node) HandleAppendEntriesReply(peerID string, args AppendEntriesArgs, reply AppendEntriesReply, peerIDs []string) {
	if reply.Term > n.CurrentTerm {
		n.CurrentTerm = reply.Term
		n.State = Follower
		n.VotedFor = ""
		return
	}

	if n.State != Leader {
		return
	}

	if reply.Success {
		newMatchIndex := args.PrevLogIndex
		if len(args.Entries) > 0 {
			newMatchIndex = args.Entries[len(args.Entries)-1].Index
		}
		if newMatchIndex > n.MatchIndex[peerID] {
			n.MatchIndex[peerID] = newMatchIndex
		}
		n.NextIndex[peerID] = newMatchIndex + 1

		n.advanceCommitIndex(peerIDs)
	} else {
		if n.NextIndex[peerID] > 1 {
			n.NextIndex[peerID]--
		}
	}
}

// advanceCommitIndex checks whether a majority of the cluster has
// replicated each not-yet-committed entry. Per Raft's safety rule (§5.4.2
// in the paper), a leader only commits entries from its own current term
// directly — older-term entries become committed indirectly.
func (n *Node) advanceCommitIndex(peerIDs []string) {
	clusterSize := len(peerIDs) + 1

	for _, entry := range n.Log {
		if entry.Index <= n.CommitIndex {
			continue
		}
		if entry.Term != n.CurrentTerm {
			continue
		}

		replicatedCount := 1
		for _, peerID := range peerIDs {
			if n.MatchIndex[peerID] >= entry.Index {
				replicatedCount++
			}
		}

		if replicatedCount*2 > clusterSize && entry.Index > n.CommitIndex {
			n.CommitIndex = entry.Index
		}
	}
}
