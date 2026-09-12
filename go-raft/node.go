package raft

import "strings"

// NodeState represents the three possible roles a Raft node can be in.
type NodeState int

const (
	Follower NodeState = iota
	Candidate
	Leader
)

func (s NodeState) String() string {
	switch s {
	case Follower:
		return "Follower"
	case Candidate:
		return "Candidate"
	case Leader:
		return "Leader"
	default:
		return "Unknown"
	}
}

// LogEntry represents a single committed (or pending) write in the replicated log.
type LogEntry struct {
	Term    int
	Index   int
	Command string
}

// Node represents a single participant in the Raft cluster.
type Node struct {
	ID    string
	State NodeState

	// Persistent state (in real Raft, this would be written to disk;
	// here it's simulated in-memory per the project's documented scope)
	CurrentTerm int
	VotedFor    string // node ID this node voted for in the current term, "" if none
	Log         []LogEntry

	// Volatile state
	CommitIndex int // highest log entry known to be committed
	LastApplied int // highest log entry applied to the state machine

	// Volatile state, leader-only (reset after election)
	NextIndex  map[string]int // for each other node, index of the next log entry to send
	MatchIndex map[string]int // for each other node, highest log entry known to be replicated

	// Simulation-specific: is this node currently "alive" or artificially killed/partitioned?
	Alive bool

	// StateMachine is the simple key-value store that committed log
	// entries get applied to. Real applications would plug in their own
	// state machine here; this project uses a minimal "SET key=value"
	// parser so replication has visible, concrete effects in the UI.
	StateMachine map[string]string
}

// NewNode creates a fresh Raft node in the initial Follower state.
func NewNode(id string) *Node {
	return &Node{
		ID:           id,
		State:        Follower,
		CurrentTerm:  0,
		VotedFor:     "",
		Log:          []LogEntry{},
		CommitIndex:  0,
		LastApplied:  0,
		NextIndex:    make(map[string]int),
		MatchIndex:   make(map[string]int),
		Alive:        true,
		StateMachine: make(map[string]string),
	}
}

// entryAtIndex returns the log entry at the given index, if present.
func (n *Node) entryAtIndex(index int) (LogEntry, bool) {
	for _, e := range n.Log {
		if e.Index == index {
			return e, true
		}
	}
	return LogEntry{}, false
}

// ApplyCommitted advances this node's state machine up to CommitIndex,
// applying any entries that have become committed but not yet applied.
// Safe to call redundantly — it's a no-op once LastApplied catches up.
func (n *Node) ApplyCommitted() {
	if n.StateMachine == nil {
		n.StateMachine = make(map[string]string)
	}
	for n.LastApplied < n.CommitIndex {
		n.LastApplied++
		entry, ok := n.entryAtIndex(n.LastApplied)
		if !ok {
			continue
		}
		applyCommand(n.StateMachine, entry.Command)
	}
}

// applyCommand parses and applies a single command string against a
// state machine. Only the "SET key=value" form is supported — anything
// else is ignored, matching this project's documented minimal scope.
func applyCommand(sm map[string]string, command string) {
	const prefix = "SET "
	if !strings.HasPrefix(command, prefix) {
		return
	}
	kv := strings.TrimPrefix(command, prefix)
	parts := strings.SplitN(kv, "=", 2)
	if len(parts) != 2 {
		return
	}
	sm[parts[0]] = parts[1]
}
