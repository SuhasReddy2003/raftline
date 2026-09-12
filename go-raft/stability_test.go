package raft

import (
	"testing"
	"time"
)

// TestNoSpuriousElectionsWhenIdle directly targets the runaway-election bug:
// a healthy 5-node cluster with no faults injected should elect a leader
// once and then stay completely stable — ElectionsHeld should never climb
// beyond 1 (allowing a little slack for a legitimate rare split vote on
// the very first election) even after sitting idle for several seconds.
func TestNoSpuriousElectionsWhenIdle(t *testing.T) {
	ids := []string{"n1", "n2", "n3", "n4", "n5"}
	c := NewCluster(ids)
	c.Start()
	defer c.Stop()

	waitForLeader(t, c, 4*time.Second)

	// Let it run completely idle — no writes, no faults — for well longer
	// than several heartbeat/election-timeout cycles would need.
	time.Sleep(5 * time.Second)

	_, stats := c.Snapshot()
	if stats.ElectionsHeld > 2 {
		t.Fatalf("expected a stable idle cluster to hold at most ~1-2 elections (allowing one legitimate split vote), got %d — this indicates spurious re-elections", stats.ElectionsHeld)
	}
	t.Logf("elections held after 5s idle: %d (healthy)", stats.ElectionsHeld)

	leaderID, ok := c.GetLeader()
	if !ok {
		t.Fatal("expected a stable leader to still exist after idle period")
	}
	t.Logf("stable leader: %s", leaderID)
}
