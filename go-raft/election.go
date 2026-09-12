package raft

import (
	"math/rand"
	"time"
)

// RequestVoteArgs is sent by a candidate to request a vote from another node.
type RequestVoteArgs struct {
	Term         int
	CandidateID  string
	LastLogIndex int
	LastLogTerm  int
}

// RequestVoteReply is sent back in response to a vote request.
type RequestVoteReply struct {
	Term        int
	VoteGranted bool
}

// RandomElectionTimeout returns a randomized duration, mimicking Raft's
// approach of randomizing timeouts so nodes don't all become candidates
// at the exact same moment (which would split votes indefinitely).
func RandomElectionTimeout() time.Duration {
	minMs := 600
	maxMs := 1000
	ms := minMs + rand.Intn(maxMs-minMs)
	return time.Duration(ms) * time.Millisecond
}

// StartElection transitions this node into a Candidate and prepares a
// vote request to send to every other node in the cluster.
func (n *Node) StartElection() RequestVoteArgs {
	n.State = Candidate
	n.CurrentTerm++
	n.VotedFor = n.ID // vote for itself

	lastLogIndex := 0
	lastLogTerm := 0
	if len(n.Log) > 0 {
		last := n.Log[len(n.Log)-1]
		lastLogIndex = last.Index
		lastLogTerm = last.Term
	}

	return RequestVoteArgs{
		Term:         n.CurrentTerm,
		CandidateID:  n.ID,
		LastLogIndex: lastLogIndex,
		LastLogTerm:  lastLogTerm,
	}
}

// HandleRequestVote is called on a node when it receives a vote request
// from a candidate. This implements Raft's safety rules for voting.
func (n *Node) HandleRequestVote(args RequestVoteArgs) RequestVoteReply {
	// Rule 1: if the candidate's term is behind ours, reject immediately.
	if args.Term < n.CurrentTerm {
		return RequestVoteReply{Term: n.CurrentTerm, VoteGranted: false}
	}

	// If we see a higher term, we update ours and become a follower again,
	// clearing any previous vote (a new election cycle has started).
	if args.Term > n.CurrentTerm {
		n.CurrentTerm = args.Term
		n.State = Follower
		n.VotedFor = ""
	}

	// Rule 2: only vote if we haven't already voted this term (or already
	// voted for this same candidate), AND the candidate's log is at least
	// as up-to-date as ours (this is Raft's core safety guarantee — it
	// prevents electing a leader that's missing committed data).
	lastLogIndex := 0
	lastLogTerm := 0
	if len(n.Log) > 0 {
		last := n.Log[len(n.Log)-1]
		lastLogIndex = last.Index
		lastLogTerm = last.Term
	}

	candidateLogIsUpToDate := args.LastLogTerm > lastLogTerm ||
		(args.LastLogTerm == lastLogTerm && args.LastLogIndex >= lastLogIndex)

	if (n.VotedFor == "" || n.VotedFor == args.CandidateID) && candidateLogIsUpToDate {
		n.VotedFor = args.CandidateID
		return RequestVoteReply{Term: n.CurrentTerm, VoteGranted: true}
	}

	return RequestVoteReply{Term: n.CurrentTerm, VoteGranted: false}
}

// BecomeLeader transitions a candidate into the leader role after winning
// a majority of votes, and initializes leader-specific tracking state.
func (n *Node) BecomeLeader(peerIDs []string) {
	n.State = Leader
	n.NextIndex = make(map[string]int)
	n.MatchIndex = make(map[string]int)

	nextIdx := len(n.Log) + 1
	for _, peerID := range peerIDs {
		n.NextIndex[peerID] = nextIdx
		n.MatchIndex[peerID] = 0
	}
}
