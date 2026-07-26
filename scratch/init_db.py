import pg8000
import sys

def init_db():
    print("Connecting to Supabase PostgreSQL database via Pooler...")
    conn = None
    
    # Supabase pooler credentials
    host = "aws-0-ap-southeast-1.pooler.supabase.com"
    user = "postgres.wrzydzgyywwfffjojzko"
    password = "9edDwwGOSQCn5EGt"
    database = "postgres"
    
    # Try port 6543 (pooler) first, then 5432
    for port in [6543, 5432]:
        try:
            print(f"Trying connection on port {port}...")
            conn = pg8000.connect(
                user=user,
                password=password,
                host=host,
                port=port,
                database=database
            )
            print(f"Connected successfully on port {port}!")
            break
        except Exception as e:
            print(f"Connection on port {port} failed: {e}")
            
    if conn is None:
        print("\nCould not connect to Supabase database. Please check:")
        print("1. Your internet connection.")
        print("2. If your network blocks standard PostgreSQL ports (5432/6543).")
        sys.exit(1)
        
    try:
        cursor = conn.cursor()
        
        # Read the SQL migration script
        print("Reading setup_supabase.sql...")
        with open("setup_supabase.sql", "r", encoding="utf-8") as f:
            sql_script = f.read()

        print("Executing schema scripts on Supabase...")
        cursor.execute(sql_script)
        conn.commit()
        
        print("Database schema and sync_records RPC function initialized successfully!")
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"Error executing database script: {e}")
        sys.exit(1)

if __name__ == "__main__":
    init_db()
