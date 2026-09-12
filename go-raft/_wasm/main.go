package main

import (
	"encoding/json"
	"syscall/js"

	raft "raftline"
)

var cluster *raft.Cluster

func jsonify(v interface{}) js.Value {
	b, err := json.Marshal(v)
	if err != nil {
		return js.ValueOf(map[string]interface{}{"error": err.Error()})
	}
	var out interface{}
	json.Unmarshal(b, &out)
	return js.ValueOf(out)
}

func newCluster(this js.Value, args []js.Value) interface{} {
	ids := make([]string, args[0].Length())
	for i := range ids {
		ids[i] = args[0].Index(i).String()
	}
	cluster = raft.NewCluster(ids)
	return nil
}

func start(this js.Value, args []js.Value) interface{} {
	cluster.Start()
	return nil
}

func stop(this js.Value, args []js.Value) interface{} {
	cluster.Stop()
	return nil
}

func pause(this js.Value, args []js.Value) interface{} {
	cluster.SetPaused(true)
	return nil
}

func resume(this js.Value, args []js.Value) interface{} {
	cluster.SetPaused(false)
	return nil
}

func killNode(this js.Value, args []js.Value) interface{} {
	cluster.KillNode(args[0].String())
	return nil
}

func reviveNode(this js.Value, args []js.Value) interface{} {
	cluster.ReviveNode(args[0].String())
	return nil
}

func partition(this js.Value, args []js.Value) interface{} {
	groupA := make([]string, args[0].Length())
	for i := range groupA {
		groupA[i] = args[0].Index(i).String()
	}
	groupB := make([]string, args[1].Length())
	for i := range groupB {
		groupB[i] = args[1].Index(i).String()
	}
	cluster.Partition(groupA, groupB)
	return nil
}

func healPartition(this js.Value, args []js.Value) interface{} {
	cluster.HealPartition()
	return nil
}

func submitWrite(this js.Value, args []js.Value) interface{} {
	index, err := cluster.SubmitWrite(args[0].String())
	if err != nil {
		return jsonify(map[string]interface{}{"error": err.Error()})
	}
	return jsonify(map[string]interface{}{"index": index})
}

func getSnapshot(this js.Value, args []js.Value) interface{} {
	nodes, stats := cluster.Snapshot()
	return jsonify(map[string]interface{}{
		"nodes": nodes,
		"stats": stats,
	})
}

func setOnEvent(this js.Value, args []js.Value) interface{} {
	callback := args[0]
	cluster.OnEvent = func(e raft.Event) {
		callback.Invoke(jsonify(e))
	}
	return nil
}

func resizeCluster(this js.Value, args []js.Value) interface{} {
	if cluster != nil {
		cluster.Stop()
	}
	ids := make([]string, args[0].Length())
	for i := range ids {
		ids[i] = args[0].Index(i).String()
	}
	cluster = raft.NewCluster(ids)
	cluster.Start()
	return nil
}

func main() {
	js.Global().Set("raftline", js.ValueOf(map[string]interface{}{
		"newCluster":     js.FuncOf(newCluster),
		"start":          js.FuncOf(start),
		"stop":           js.FuncOf(stop),
		"pause":          js.FuncOf(pause),
		"resume":         js.FuncOf(resume),
		"killNode":       js.FuncOf(killNode),
		"reviveNode":     js.FuncOf(reviveNode),
		"partition":      js.FuncOf(partition),
		"healPartition":  js.FuncOf(healPartition),
		"submitWrite":    js.FuncOf(submitWrite),
		"getSnapshot":    js.FuncOf(getSnapshot),
		"setOnEvent":     js.FuncOf(setOnEvent),
		"resizeCluster":  js.FuncOf(resizeCluster),
	}))
	select {} // keep the Go program alive
}