package raft

import (
	"testing"
	"time"
)

func waitForLeader(t *testing.T, c *Cluster, timeout time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if id, ok := c.GetLeader(); ok {
			return id
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no leader elected within %v", timeout)
	return ""
}

// submitWriteWithRetry models how a real Raft client is expected to behave
// (per the Raft paper's §8 discussion of client interaction): a write
// accepted by a leader that gets deposed before replicating it is silently
// lost — SubmitWrite's own contract only promises local acceptance, not
// eventual commitment. This is most likely to bite immediately after a
// failover, when several nodes can race to become candidates and a
// short-lived, soon-to-be-superseded leader can transiently accept a write
// that never gets a chance to replicate. A correct client retries until it
// observes the write actually commit, exactly as this helper does.
func submitWriteWithRetry(t *testing.T, c *Cluster, command string, overallTimeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(overallTimeout)
	for time.Now().Before(deadline) {
		_, before := c.Snapshot()
		if _, err := c.SubmitWrite(command); err != nil {
			time.Sleep(50 * time.Millisecond)
			continue
		}
		subDeadline := time.Now().Add(700 * time.Millisecond)
		for time.Now().Before(subDeadline) {
			_, stats := c.Snapshot()
			if stats.WritesCommitted > before.WritesCommitted {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		// Didn't commit within this attempt's window — most likely landed
		// on a leader that has since been deposed. Loop and resubmit
		// against whatever the current leader is now.
	}
	t.Fatalf("write %q did not commit within %v even with retries", command, overallTimeout)
}

func waitForCommitCount(t *testing.T, c *Cluster, want int, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		_, stats := c.Snapshot()
		if stats.WritesCommitted >= want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, stats := c.Snapshot()
	t.Fatalf("timed out waiting for %d commits, got %d", want, stats.WritesCommitted)
}

// TestFullLifecycle exercises the exact demo scenario the frontend needs:
// cluster boots -> leader emerges -> a write commits -> the leader is
// killed -> a new leader emerges -> further writes still commit.
func TestFullLifecycle(t *testing.T) {
	ids := []string{"n1", "n2", "n3", "n4", "n5"}
	c := NewCluster(ids)
	c.Start()
	defer c.Stop()

	firstLeader := waitForLeader(t, c, 2*time.Second)
	t.Logf("elected first leader: %s", firstLeader)

	submitWriteWithRetry(t, c, "SET x=1", 6*time.Second)

	c.KillNode(firstLeader)
	t.Logf("killed leader: %s", firstLeader)

	deadline := time.Now().Add(3 * time.Second)
	var secondLeader string
	for time.Now().Before(deadline) {
		if id, ok := c.GetLeader(); ok && id != firstLeader {
			secondLeader = id
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if secondLeader == "" {
		t.Fatalf("no new leader elected after killing %s within 3s", firstLeader)
	}
	t.Logf("elected second leader: %s", secondLeader)

	// This is exactly the case submitWriteWithRetry exists for: right after
	// a failover, a transient short-lived leader can accept this write and
	// then get deposed before replicating it, silently losing it. A real
	// client retries; so do we.
	submitWriteWithRetry(t, c, "SET x=2", 6*time.Second)

	snap, stats := c.Snapshot()
	if stats.ElectionsHeld < 2 {
		t.Fatalf("expected at least 2 elections (initial + failover), got %d", stats.ElectionsHeld)
	}
	aliveLeaders := 0
	for _, n := range snap {
		if n.Alive && n.State == "Leader" {
			aliveLeaders++
		}
	}
	if aliveLeaders != 1 {
		t.Fatalf("expected exactly 1 alive leader after failover, found %d", aliveLeaders)
	}
}

// TestNoSplitBrainDuringPartition is the safety-critical case: split the
// cluster into a majority (3) and a minority (2) partition, and confirm at
// no point do two nodes both believe they are leader for the *same term*
// (real Raft's split-brain guarantee), and that only the majority side can
// make progress.
func TestNoSplitBrainDuringPartition(t *testing.T) {
	ids := []string{"n1", "n2", "n3", "n4", "n5"}
	c := NewCluster(ids)

	seenLeaderTerms := make(map[int]string)
	var badSplit string
	c.OnEvent = func(e Event) {
		if e.Type != "leader_elected" {
			return
		}
		if existing, ok := seenLeaderTerms[e.Term]; ok && existing != e.NodeID {
			badSplit = "two different leaders elected in the same term: " +
				existing + " and " + e.NodeID
		}
		seenLeaderTerms[e.Term] = e.NodeID
	}

	c.Start()
	defer c.Stop()

	waitForLeader(t, c, 2*time.Second)

	majority := []string{"n1", "n2", "n3"}
	minority := []string{"n4", "n5"}
	c.Partition(majority, minority)
	t.Log("partitioned: majority {n1,n2,n3} | minority {n4,n5}")

	// Give the cluster time to react: the minority side may re-elect among
	// itself (it can't reach a majority so it should never actually win),
	// and the majority side should retain or re-elect a working leader.
	time.Sleep(1500 * time.Millisecond)

	if badSplit != "" {
		t.Fatal(badSplit)
	}

	leaderID, ok := c.GetLeader()
	if !ok {
		t.Fatal("expected the majority side to still have a functioning leader during the partition")
	}
	inMajority := false
	for _, id := range majority {
		if id == leaderID {
			inMajority = true
		}
	}
	if !inMajority {
		t.Fatalf("leader %s is not in the majority partition — minority should never be able to elect a leader", leaderID)
	}

	submitWriteWithRetry(t, c, "SET during-partition=1", 6*time.Second)

	c.HealPartition()
	t.Log("partition healed")
	time.Sleep(500 * time.Millisecond)

	if badSplit != "" {
		t.Fatal(badSplit)
	}
}