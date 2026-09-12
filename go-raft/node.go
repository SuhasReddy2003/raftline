package raft

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
}

// NewNode creates a fresh Raft node in the initial Follower state.
func NewNode(id string) *Node {
	return &Node{
		ID:          id,
		State:       Follower,
		CurrentTerm: 0,
		VotedFor:    "",
		Log:         []LogEntry{},
		CommitIndex: 0,
		LastApplied: 0,
		NextIndex:   make(map[string]int),
		MatchIndex:  make(map[string]int),
		Alive:       true,
	}
}