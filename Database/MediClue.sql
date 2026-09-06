CREATE TABLE Patients(
	PatientID INT PRIMARY KEY,
    Fname VARCHAR(20),
    Mint VARCHAR(10),
    Lname VARCHAR(20),
    Sex VARCHAR(2),
    B_Date DATE,
    Illness VARCHAR(100)
);

CREATE TABLE DOCTOR(
	DoctorID INT PRIMARY KEY,
    Fname VARCHAR(20),
    Mint VARCHAR(10),
    Lname VARCHAR(20),
    Speciality VARCHAR(100),
    StartTime TIME,
    EndTime TIME
);

CREATE TABLE APPOINTMENT(
	AppointmentID INT Primary KEY,
    PatientID INT,
    DoctorID INT,
    Appointment_Date DATE,
    Appointment_Time TIME,
    Appointment_Type(Walkin/Booked) VARCHAR(100),
    Priority VARCHAR(100),
    Appointment_Status(Waiting/In-Prog/Completed/Cancelled) VARCHAR(100),
    ArrivalTime TIME,
    VisitHistoryNote VARCHAR(100),
    
    FOREIGN KEY (PatientID)
		REFERENCES PATIENTS(PatientID),
        
	FOREIGN KEY (DoctorID)
		REFERENCES DOCTOR(DoctorID)
);