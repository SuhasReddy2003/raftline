package raft

import (
	"errors"
	"fmt"
	"hash/fnv"
	"math/rand"
	"sort"
	"sync"
	"time"
)

// Event is emitted by the cluster for anything visualization-worthy.
// The frontend (or a WASM bridge) can subscribe via Cluster.OnEvent.
type Event struct {
	Time time.Time
	Type string // "election_started" | "leader_elected" | "vote_rejected" |
	// "node_failed" | "node_recovered" | "partitioned" | "healed" |
	// "write_submitted" | "committed"
	NodeID string
	Term   int
	Index  int
	Detail string
}

// Stats holds cluster-wide counters for the live stat ticker in the UI.
type Stats struct {
	StartedAt       time.Time
	ElectionsHeld   int
	WritesSubmitted int
	WritesCommitted int
	AvgLatencyMs    float64
}

// Cluster runs a set of Nodes concurrently (one goroutine per node) and
// simulates the network between them: randomized RPC latency, and the
// ability to kill nodes or partition the network on demand.
//
// Concurrency model: rather than raw channels for every RPC (deadlock-prone
// once you add fault injection), each simulated RPC is its own goroutine
// that sleeps to model latency and then acquires a single cluster-wide
// mutex to read/mutate node state. This keeps every individual Node's
// methods (StartElection, HandleAppendEntries, etc.) exactly as written —
// none of them are lock-aware — while still letting many "in-flight RPCs"
// exist concurrently, which is what actually needs to be true for a
// partition/failure demo to look real.
type Cluster struct {
	mu        sync.Mutex
	nodes     map[string]*Node
	peers     map[string][]string        // peers[id] = every other node ID
	reachable map[string]map[string]bool // reachable[a][b] = false if a cannot currently reach b

	resetCh map[string]chan struct{} // per-node election-timer reset signal

	stopCh chan struct{}
	wg     sync.WaitGroup

	stats Stats

	// paused, when true, freezes election timeouts and leader heartbeats
	// from actually firing (the underlying timers/tickers keep running,
	// they just no-op) — set via SetPaused, driven by the frontend's
	// document.visibilitychange so a backgrounded/throttled tab can't
	// build up a burst of delayed timer fires that all land at once.
	paused bool

	// events is drained by a single dedicated goroutine (started in Start)
	// so that OnEvent is always invoked from exactly one goroutine, in
	// emission order. This matters beyond just avoiding data races in a
	// consumer's own state: once this is exposed to JS via the WASM build,
	// JS callbacks are not safe to call concurrently from multiple Go
	// goroutines, so serialized delivery is a real requirement, not just
	// test hygiene.
	events chan Event

	// highestCommittedIndex is the cluster-wide high-water mark of "an
	// entry at this index has been confirmed committed by some leader."
	// It's tracked independently of any single node's CommitIndex because
	// after a leadership change, the new leader's own CommitIndex starts
	// wherever it happened to be as a follower (often behind the old
	// leader's), so a naive "delta on this leader's CommitIndex" undercounts
	// or, worse, double-counts: committing a later entry can jump the new
	// leader's CommitIndex past an entry that a *previous* leader already
	// got committed, which would otherwise be recounted as newly committed.
	highestCommittedIndex int

	// lastElectionAttempt tracks, per node, when it last actually started
	// an election — used as the anchor point for computing exponential
	// backoff below.
	lastElectionAttempt map[string]time.Time

	// electionFailStreak tracks, per node, how many consecutive elections
	// it has started without becoming leader or hearing from a real leader
	// since. Used to back off exponentially rather than retrying at a flat
	// rate — a flat rate-limit only caps the *speed* of a feedback-loop
	// storm (something falls behind -> retries -> more events -> more
	// contention -> falls further behind), it doesn't break the loop.
	// Exponential backoff, the standard fix for exactly this failure mode,
	// actually breaks it.
	electionFailStreak map[string]int

	// OnEvent, if set, is called for every simulation event, one at a
	// time, from the dispatch goroutine. Safe for it to call back into
	// Cluster methods (e.g. to update a UI).
	OnEvent     func(Event)
	latencyEWMA float64
}

// minElectionInterval is the base floor between successive election
// attempts by the same node before any backoff is applied.
const minElectionInterval = 400 * time.Millisecond

// maxElectionBackoff caps how long exponential backoff can push a retry
// interval out to, so a node that's been failing for a while doesn't end
// up waiting absurdly long once things recover.
const maxElectionBackoff = 5 * time.Second

// NewCluster creates a cluster of nodes with the given IDs. Call Start to
// begin the election-timeout and heartbeat goroutines.
func NewCluster(ids []string) *Cluster {
	c := &Cluster{
		nodes:               make(map[string]*Node),
		peers:               make(map[string][]string),
		reachable:           make(map[string]map[string]bool),
		resetCh:             make(map[string]chan struct{}),
		stopCh:              make(chan struct{}),
		events:              make(chan Event, 256),
		stats:               Stats{StartedAt: time.Now()},
		lastElectionAttempt: make(map[string]time.Time),
		electionFailStreak:  make(map[string]int),
	}

	for _, id := range ids {
		c.nodes[id] = NewNode(id)
		c.resetCh[id] = make(chan struct{}, 1)
		c.reachable[id] = make(map[string]bool)
	}
	for _, id := range ids {
		for _, other := range ids {
			if other != id {
				c.peers[id] = append(c.peers[id], other)
				c.reachable[id][other] = true
			}
		}
	}
	return c
}

// ---- lifecycle ----------------------------------------------------------

// Start launches one election-timeout goroutine and one heartbeat goroutine
// per node.
func (c *Cluster) Start() {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.eventDispatchLoop()
	}()

	for id := range c.nodes {
		id := id
		c.wg.Add(2)
		go func() {
			defer c.wg.Done()
			c.electionTimeoutLoop(id)
		}()
		go func() {
			defer c.wg.Done()
			c.leaderHeartbeatLoop(id)
		}()
	}
}

// eventDispatchLoop is the single goroutine that ever calls OnEvent,
// guaranteeing serialized, in-order delivery to the consumer.
func (c *Cluster) eventDispatchLoop() {
	for {
		select {
		case <-c.stopCh:
			return
		case e := <-c.events:
			if c.OnEvent != nil {
				c.OnEvent(e)
			}
		}
	}
}

// Stop halts every goroutine and waits for them to exit.
func (c *Cluster) Stop() {
	close(c.stopCh)
	c.wg.Wait()
}

// SetPaused freezes (true) or resumes (false) election timeouts and leader
// heartbeats cluster-wide. The underlying timers/tickers keep running
// either way — pausing just makes their fire cases no-op — so on resume
// we explicitly reset every node's election timer rather than letting
// whatever the (possibly throttled, backed-up) timer last had queued carry
// over. This is the fix for elections spiking after a backgrounded browser
// tab gets throttled by Chrome and its timers fire in a delayed burst: the
// frontend calls SetPaused(true) on document.hidden and SetPaused(false)
// on visibility restore, so nothing fires while the tab is backgrounded.
func (c *Cluster) SetPaused(p bool) {
	c.mu.Lock()
	c.paused = p
	c.mu.Unlock()
	if !p {
		for id := range c.nodes {
			c.resetElectionTimer(id)
		}
	}
}

// ---- fault injection ------------------------------------------------------

// KillNode marks a node as down. In-flight RPCs to/from it will fail to
// deliver; its election timer keeps ticking but the node just won't act on
// it while dead.
func (c *Cluster) KillNode(id string) {
	c.mu.Lock()
	if n, ok := c.nodes[id]; ok {
		n.Alive = false
	}
	c.mu.Unlock()
	c.emit(Event{Time: time.Now(), Type: "node_failed", NodeID: id})
}

// ReviveNode brings a node back as a Follower (real Raft nodes rejoin with
// whatever persistent state they had — term, log, vote — and catch up via
// normal AppendEntries; only the simulation-specific Alive flag changes here).
func (c *Cluster) ReviveNode(id string) {
	c.mu.Lock()
	if n, ok := c.nodes[id]; ok {
		n.Alive = true
		n.State = Follower
	}
	c.mu.Unlock()
	c.resetElectionTimer(id)
	c.emit(Event{Time: time.Now(), Type: "node_recovered", NodeID: id})
}

// Partition cuts network reachability between two groups of nodes (both
// directions). Nodes within the same group can still reach each other.
func (c *Cluster) Partition(groupA, groupB []string) {
	c.mu.Lock()
	for _, a := range groupA {
		for _, b := range groupB {
			c.reachable[a][b] = false
			c.reachable[b][a] = false
		}
	}
	c.mu.Unlock()
	c.emit(Event{Time: time.Now(), Type: "partitioned", Detail: fmt.Sprintf("%v | %v", groupA, groupB)})
}

// HealPartition restores full connectivity between every node.
func (c *Cluster) HealPartition() {
	c.mu.Lock()
	for a := range c.reachable {
		for b := range c.reachable[a] {
			c.reachable[a][b] = true
		}
	}
	c.mu.Unlock()
	c.emit(Event{Time: time.Now(), Type: "healed"})
}

// ---- writes ---------------------------------------------------------------

var ErrNoLeader = errors.New("no leader currently available")

// SubmitWrite appends a command to the current leader's log. Replication to
// followers happens via the normal heartbeat/AppendEntries cycle already
// running in the background, so this call returns as soon as the leader has
// accepted the entry locally — not once it's committed.
func (c *Cluster) SubmitWrite(command string) (index int, err error) {
	c.mu.Lock()
	leader := c.findLeaderLocked()
	if leader == nil {
		c.mu.Unlock()
		return 0, ErrNoLeader
	}
	nextIndex := 1
	if len(leader.Log) > 0 {
		nextIndex = leader.Log[len(leader.Log)-1].Index + 1
	}
	leader.Log = append(leader.Log, LogEntry{
		Term:    leader.CurrentTerm,
		Index:   nextIndex,
		Command: command,
	})
	c.stats.WritesSubmitted++
	leaderID := leader.ID
	peers := append([]string{}, c.peers[leaderID]...)
	c.mu.Unlock()

	c.emit(Event{Time: time.Now(), Type: "write_submitted", NodeID: leaderID, Index: nextIndex, Detail: command})

	// Kick replication immediately instead of waiting for the next
	// heartbeat tick, so the UI feels responsive.
	for _, p := range peers {
		go c.sendAppendEntries(leaderID, p)
	}
	return nextIndex, nil
}

// findLeaderLocked requires c.mu to already be held.
//
// More than one node can locally believe State == Leader at the same time
// — this is correct Raft behavior, not a bug: a leader that's partitioned
// away from the majority has no way to learn a new leader was elected in a
// higher term, so it keeps believing it's leader (it just can never get a
// write committed, since it can't reach a majority). When that happens we
// must route to the node with the highest CurrentTerm, which is always the
// legitimate one per Raft's term-ordering invariant — otherwise a write
// can land on the stale leader and silently never commit.
func (c *Cluster) findLeaderLocked() *Node {
	var best *Node
	for _, n := range c.nodes {
		if !n.Alive || n.State != Leader {
			continue
		}
		if best == nil || n.CurrentTerm > best.CurrentTerm {
			best = n
		}
	}
	return best
}

// GetLeader returns the current leader's ID, if any.
func (c *Cluster) GetLeader() (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if n := c.findLeaderLocked(); n != nil {
		return n.ID, true
	}
	return "", false
}

// ---- snapshotting for the UI ----------------------------------------------

// NodeSnapshot is a read-only, race-free copy of a node's visible state.
type NodeSnapshot struct {
	ID          string
	State       string
	CurrentTerm int
	VotedFor    string
	LogLength   int
	CommitIndex int
	Alive       bool
	Log         []LogEntry
	Unreachable []string
}

// Snapshot returns a consistent point-in-time view of every node plus
// cluster stats, safe to hand to a renderer.

func (c *Cluster) Snapshot() ([]NodeSnapshot, Stats) {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]NodeSnapshot, 0, len(c.nodes))
	for id, n := range c.nodes {
		unreachable := []string{}
		for peer, ok := range c.reachable[id] {
			if !ok {
				unreachable = append(unreachable, peer)
			}
		}
		sort.Strings(unreachable)
		out = append(out, NodeSnapshot{
			ID:          id,
			State:       n.State.String(),
			CurrentTerm: n.CurrentTerm,
			VotedFor:    n.VotedFor,
			LogLength:   len(n.Log),
			CommitIndex: n.CommitIndex,
			Alive:       n.Alive,
			Log:         append([]LogEntry{}, n.Log...),
			Unreachable: unreachable,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, c.stats
}

// ---- internals: simulated network -----------------------------------------

// latency models one-way simulated network delay, 5-50ms.
func (c *Cluster) latency() time.Duration {
	ms := 5 + rand.Intn(46)
	c.mu.Lock()
	if c.latencyEWMA == 0 {
		c.latencyEWMA = float64(ms)
	} else {
		c.latencyEWMA = c.latencyEWMA*0.9 + float64(ms)*0.1
	}
	c.stats.AvgLatencyMs = c.latencyEWMA
	c.mu.Unlock()
	return time.Duration(ms) * time.Millisecond
}

// canReach reports whether `from` can currently deliver an RPC to `to`:
// both must be alive and not partitioned from each other.
func (c *Cluster) canReach(from, to string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	fromNode, ok1 := c.nodes[from]
	toNode, ok2 := c.nodes[to]
	if !ok1 || !ok2 || !fromNode.Alive || !toNode.Alive {
		return false
	}
	if m, ok := c.reachable[from]; ok {
		if v, ok := m[to]; ok {
			return v
		}
	}
	return true
}

// emit is a non-blocking enqueue; the actual OnEvent call happens later,
// serially, on the dispatch goroutine. If the buffer is ever full (OnEvent
// consumer stalled), we drop the event rather than block the simulation.
func (c *Cluster) emit(e Event) {
	select {
	case c.events <- e:
	default:
	}
}

func (c *Cluster) resetElectionTimer(id string) {
	ch, ok := c.resetCh[id]
	if !ok {
		return
	}
	select {
	case ch <- struct{}{}:
	default:
	}
}

// electionTimeoutForNode wraps RandomElectionTimeout() with a small,
// deterministic per-node stagger (0-149ms, derived from hashing the node
// ID) added on top of the existing 600-1000ms random range. This is a
// second, structural layer of defense (alongside minElectionInterval)
// against nodes' timeouts ever ending up synchronized: even if some
// WASM-runtime scheduling artifact ever caused random draws across
// multiple goroutines to correlate more than expected — real OS-thread
// concurrency (which our native Go test suite runs under) gives much
// stronger independence guarantees than the cooperative, single-JS-thread
// scheduling this code actually runs under once compiled to WASM in a
// browser — each node's timeout floor still structurally differs by
// identity, so all five nodes landing on the exact same instant is no
// longer just unlikely, it's impossible by construction.
func electionTimeoutForNode(nodeID string) time.Duration {
	base := RandomElectionTimeout()
	h := fnv.New32a()
	h.Write([]byte(nodeID))
	stagger := time.Duration(h.Sum32()%150) * time.Millisecond
	return base + stagger
}

// electionTimeoutLoop is the per-node goroutine that fires an election
// whenever the node hasn't heard from a leader (or granted a vote) within
// a randomized timeout. Leaders never fire elections against themselves;
// this loop just idles for them until they step down.
func (c *Cluster) electionTimeoutLoop(id string) {
	timer := time.NewTimer(electionTimeoutForNode(id))
	defer timer.Stop()

	for {
		select {
		case <-c.stopCh:
			return

		case <-c.resetCh[id]:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(electionTimeoutForNode(id))

		case <-timer.C:
			c.mu.Lock()
			n := c.nodes[id]
			shouldRun := n.Alive && n.State != Leader && !c.paused
			c.mu.Unlock()
			if shouldRun {
				c.runElection(id)
			}
			timer.Reset(electionTimeoutForNode(id))
		}
	}
}

// runElection drives one election attempt for the given candidate: it
// transitions the node via StartElection(), fires RequestVote RPCs to every
// peer concurrently, and promotes the node via BecomeLeader() the moment a
// majority of votes is in.
func (c *Cluster) runElection(candidateID string) {
	c.mu.Lock()
	cand, ok := c.nodes[candidateID]
	if !ok || !cand.Alive {
		c.mu.Unlock()
		return
	}

	// Exponential backoff: the required gap since this node's last attempt
	// grows with its consecutive-failure streak (doubling each time, capped
	// at maxElectionBackoff), rather than staying at a flat interval. A
	// flat rate-limit only caps how *fast* a feedback-loop storm can run;
	// it doesn't stop one from being sustained indefinitely once started.
	// Backoff actually breaks the loop by giving the system increasing
	// amounts of breathing room to actually recover.
	streak := c.electionFailStreak[candidateID]
	backoff := minElectionInterval * time.Duration(1<<uint(min(streak, 5)))
	if backoff > maxElectionBackoff {
		backoff = maxElectionBackoff
	}
	if last, seen := c.lastElectionAttempt[candidateID]; seen {
		if time.Since(last) < backoff {
			c.mu.Unlock()
			return
		}
	}
	c.lastElectionAttempt[candidateID] = time.Now()
	c.electionFailStreak[candidateID] = streak + 1

	args := cand.StartElection()
	peerIDs := append([]string{}, c.peers[candidateID]...)
	c.stats.ElectionsHeld++
	c.mu.Unlock()

	c.emit(Event{Time: time.Now(), Type: "election_started", NodeID: candidateID, Term: args.Term})

	clusterSize := len(peerIDs) + 1
	majority := clusterSize/2 + 1

	var votesMu sync.Mutex
	votes := 1 // candidate votes for itself in StartElection

	for _, peerID := range peerIDs {
		peerID := peerID
		go func() {
			if !c.canReach(candidateID, peerID) {
				return
			}
			time.Sleep(c.latency())
			if !c.canReach(candidateID, peerID) {
				return
			}

			c.mu.Lock()
			peer, ok := c.nodes[peerID]
			if !ok || !peer.Alive {
				c.mu.Unlock()
				return
			}
			reply := peer.HandleRequestVote(args)
			c.mu.Unlock()

			voteType := "vote_rejected"
			if reply.VoteGranted {
				voteType = "vote_granted"
			}
			c.emit(Event{Time: time.Now(), Type: voteType, NodeID: peerID, Term: reply.Term, Detail: candidateID})

			if reply.VoteGranted {
				c.resetElectionTimer(peerID)
			}

			time.Sleep(c.latency())

			c.mu.Lock()
			defer c.mu.Unlock()

			cur, ok := c.nodes[candidateID]
			if !ok || cur.State != Candidate || cur.CurrentTerm != args.Term {
				return // stale: election already resolved or superseded
			}

			if reply.Term > cur.CurrentTerm {
				cur.CurrentTerm = reply.Term
				cur.State = Follower
				cur.VotedFor = ""
				return
			}

			if !reply.VoteGranted {
				return
			}

			votesMu.Lock()
			votes++
			won := votes >= majority
			votesMu.Unlock()

			if won && cur.State == Candidate {
				cur.BecomeLeader(peerIDs)
				delete(c.electionFailStreak, candidateID)
				c.emit(Event{Time: time.Now(), Type: "leader_elected", NodeID: candidateID, Term: cur.CurrentTerm})
			}
		}()
	}
}

// leaderHeartbeatLoop periodically sends AppendEntries (which naturally
// serves as a heartbeat when there's nothing new to replicate) from a node
// to every peer, but only while that node is actually the leader.
func (c *Cluster) leaderHeartbeatLoop(id string) {
	// 100ms keeps a healthy safety margin under the new 600-1000ms election
	// timeout (matching the Raft paper's guidance that broadcast time stay
	// an order of magnitude below election timeout) while halving how many
	// times per second this crosses the JS/WASM boundary compared to the
	// original 50ms, further reducing browser main-thread contention.
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.mu.Lock()
			n := c.nodes[id]
			isLeader := n.Alive && n.State == Leader && !c.paused
			peers := append([]string{}, c.peers[id]...)
			c.mu.Unlock()

			if !isLeader {
				continue
			}
			for _, peerID := range peers {
				go c.sendAppendEntries(id, peerID)
			}
		}
	}
}

// sendAppendEntries simulates one AppendEntries RPC round trip from a
// leader to a follower, including request latency, delivery, reply
// latency, and processing the reply back on the leader.
func (c *Cluster) sendAppendEntries(leaderID, peerID string) {
	if !c.canReach(leaderID, peerID) {
		return
	}

	c.mu.Lock()
	leader, ok := c.nodes[leaderID]
	if !ok || leader.State != Leader || !leader.Alive {
		c.mu.Unlock()
		return
	}
	args := leader.MakeAppendEntries(peerID)
	c.mu.Unlock()

	time.Sleep(c.latency())
	if !c.canReach(leaderID, peerID) {
		return
	}

	c.mu.Lock()
	peer, ok := c.nodes[peerID]
	if !ok || !peer.Alive {
		c.mu.Unlock()
		return
	}
	reply := peer.HandleAppendEntries(args)
	if args.Term >= peer.CurrentTerm {
		// A valid AppendEntries from a current (or newer) leader resets
		// this follower's election clock — it has proof the leader is
		// alive — and clears its backoff streak, since it's no longer in
		// a failed-election spiral of its own.
		delete(c.electionFailStreak, peerID)
		c.mu.Unlock()
		c.resetElectionTimer(peerID)
	} else {
		c.mu.Unlock()
	}

	time.Sleep(c.latency())
	if !c.canReach(leaderID, peerID) {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	leader, ok = c.nodes[leaderID]
	if !ok || leader.State != Leader {
		return
	}
	peerIDs := c.peers[leaderID]
	leader.HandleAppendEntriesReply(peerID, args, reply, peerIDs)

	if leader.CommitIndex > c.highestCommittedIndex {
		delta := leader.CommitIndex - c.highestCommittedIndex
		c.stats.WritesCommitted += delta
		c.highestCommittedIndex = leader.CommitIndex
		c.emit(Event{Time: time.Now(), Type: "committed", NodeID: leaderID, Term: leader.CurrentTerm, Index: leader.CommitIndex})
	}
}
