import json
import numpy as np

def create_signatures(file_path='warehouse.jsonl'):
    signatures = {}
    label_groups = {}

    # 1. Group DNA by their Semantic Labels
    with open(file_path, 'r') as f:
        for line in f:
            entry = json.loads(line)
            label = entry['label']
            
            # Skip "none" or empty labels
            if label == "none" or label == "":
                continue
                
            if label not in label_groups:
                label_groups[label] = []
            label_groups[label].append(entry['fingerprint'])

    # 2. Calculate the "Centroid" (Average) for each label
    for label, fingerprints in label_groups.items():
        arr = np.array(fingerprints)
        # The average 16-dimensional vector for this behavior
        centroid = np.mean(arr, axis=0)
        signatures[label] = centroid.tolist()
        print(f"✅ Signature Created: '{label}' (based on {len(fingerprints)} samples)")

    # 3. Save to our Signature Bank for the Worker to use later
    with open('signatures.json', 'w') as f:
        json.dump(signatures, f)
    print("\n🚀 signatures.json exported! Your Worker can now 'recognize' these.")

if __name__ == "__main__":
    create_signatures()