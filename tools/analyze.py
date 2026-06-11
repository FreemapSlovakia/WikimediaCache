import sys
import gzip
from collections import Counter

def stream_records(file_path, batch_size=4000):
    """
    Generator that reads the dump as a stream and yields raw records in batches.
    """
    batch = []
    
    # Autodetect gzip
    open_func = gzip.open if str(file_path).endswith('.gz') else open
    
    with open_func(file_path, 'rt', encoding='utf-8', errors='ignore') as f:
        for line in f:
            # Skip lines that don't contain data (table structure, comments)
            if not line.startswith("INSERT INTO `geo_tags` VALUES"):
                continue
            
            # Strip SQL syntax to get clean data
            prefix_idx = line.find("VALUES (")
            if prefix_idx == -1:
                continue
                
            data_str = line[prefix_idx + 8 : -2] 
            rows = data_str.split("),(")
            
            # Add to batch and yield when limit is reached
            for row in rows:
                batch.append(row)
                if len(batch) >= batch_size:
                    yield batch
                    batch = []
                    
        # Yield remaining records at the end of the file
        if batch:
            yield batch

def analyze_dump_stream(file_path):
    type_counts = Counter()
    country_counts = Counter()
    total_processed = 0
    
    print(f"Starting to stream file: {file_path}")
    print("-" * 50)
    
    # Stream and process exactly 4000 records at a time
    for batch in stream_records(file_path, batch_size=4000):
        for row in batch:
            parts = [p.strip() for p in row.split(',')]
            
            if len(parts) >= 13:
                # Safe extraction trick
                gt_type = parts[7].strip("'")
                gt_country = parts[-4].strip("'")
                
                type_counts[gt_type] += 1
                country_counts[gt_country] += 1
                
        total_processed += len(batch)
        
        # \r ensures text overwrites the same line instead of scrolling
        print(f"Currently processed records: {total_processed}", end='\r')
        
    print(f"\n\nDone! Total read records: {total_processed}")
    
    # --- PRINT RESULTS ---
    print("\n" + "="*30)
    print(" TOP 100 TYPES (gt_type)")
    print("="*30)
    for t, count in type_counts.most_common(100):
        display_t = "NULL (empty)" if t == "NULL" else t
        print(f"{display_t}: {count}x")
        
    print("\n" + "="*30)
    print(" TOP 100 COUNTRIES (gt_country)")
    print("="*30)
    for c, count in country_counts.most_common(100):
        display_c = "NULL (empty)" if c == "NULL" else c
        print(f"{display_c}: {count}x")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 analyze.py <file_path.sql[.gz]>")
        sys.exit(1)
        
    file_path = sys.argv[1]
    analyze_dump_stream(file_path)