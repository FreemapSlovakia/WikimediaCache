import sys
import gzip

def display_record(parts):
    """
    Function to cleanly display all columns of a record.
    Handles issues with potential commas in the object name (gt_name).
    """
    # Left side (indexes 0 to 7)
    gt_id = parts[0].strip()
    gt_page_id = parts[1].strip()
    gt_globe = parts[2].strip().strip("'")
    gt_primary = parts[3].strip()
    gt_lat = parts[4].strip()
    gt_lon = parts[5].strip()
    gt_dim = parts[6].strip()
    gt_type = parts[7].strip().strip("'")

    # Right side (indexes from the end)
    gt_lon_int = parts[-1].strip()
    gt_lat_int = parts[-2].strip()
    gt_region = parts[-3].strip().strip("'")
    gt_country = parts[-4].strip().strip("'")

    # Center (name) - if the name contained a comma, it was split into multiple elements.
    # We join everything between index 8 and the last 4 elements.
    gt_name_parts = parts[8:-4]
    gt_name = ",".join(gt_name_parts).strip().strip("'")

    print("\n" + "="*40)
    print(" RECORD FOUND")
    print("="*40)
    print(f" gt_id:       {gt_id}")
    print(f" gt_page_id:  {gt_page_id}")
    print(f" gt_globe:    {gt_globe}")
    print(f" gt_primary:  {gt_primary}")
    print(f" gt_lat:      {gt_lat}")
    print(f" gt_lon:      {gt_lon}")
    print(f" gt_dim:      {gt_dim}")
    print(f" gt_type:     {gt_type}")
    print(f" gt_name:     {gt_name}")
    print(f" gt_country:  {gt_country}")
    print(f" gt_region:   {gt_region}")
    print(f" gt_lat_int:  {gt_lat_int}")
    print(f" gt_lon_int:  {gt_lon_int}")
    print("="*40 + "\n")

def find_page_id(file_path, target_id):
    target_str = f",{target_id},"
    found = False
    
    print(f"Searching file: {file_path}")
    print(f"Looking for gt_page_id: {target_id} ... (please wait)")
    
    try:
        # Autodetect gzip
        open_func = gzip.open if str(file_path).endswith('.gz') else open
        
        with open_func(file_path, 'rt', encoding='utf-8', errors='ignore') as f:
            for line in f:
                if not line.startswith("INSERT INTO `geo_tags` VALUES"):
                    continue
                
                # Extremely fast filter: if the ID is not found at all in the whole block (line),
                # skip the entire line without complex parsing.
                if target_str not in line:
                    continue
                
                prefix_idx = line.find("VALUES (")
                if prefix_idx == -1:
                    continue
                    
                data_str = line[prefix_idx + 8 : -2]
                rows = data_str.split("),(")
                
                for row in rows:
                    # Quick check before string splitting
                    if target_str in row:
                        parts = row.split(',')
                        # Verify it's actually gt_page_id (2nd column) and not for instance gt_dim
                        if len(parts) >= 13 and parts[1].strip() == str(target_id):
                            display_record(parts)
                            found = True
                            
    except FileNotFoundError:
        print(f"Error: File {file_path} not found.")
        return

    if not found:
        print(f"Record for gt_page_id = {target_id} was not found in the database.")

if __name__ == "__main__":
    # Check if enough arguments were provided
    if len(sys.argv) < 3:
        print("Usage: python3 find.py <file_path.sql[.gz]> <gt_page_id>")
        print("Example: python3 find.py geo_tags.sql.gz 111545232")
        sys.exit(1)
        
    # Read from command line
    dump_file = sys.argv[1]
    target_page_id = sys.argv[2]
    
    find_page_id(dump_file, target_page_id)